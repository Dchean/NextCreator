/**
 * 图片生成执行器（无 React 依赖）
 * 供手动生成、生成队列、批量生成共用：
 * - 画布感知的输入解析（节点在后台画布也能正确执行）
 * - 运行记录、元数据（模型）落盘、缩略图路径
 * - 取消（AbortSignal）
 *
 * ⚠ 取消的**真实边界**（REQ-006 要求明确说明，不得夸大）：
 *   本执行器能保证的是 —— 取消后**不把结果写回**：不写节点状态、不写运行记录、不把这次结果
 *   持久化到画布/app-data.json。为此在请求前、请求返回后、以及每个 await 落盘步骤之后都复查
 *   `signal.aborted`（这些复查点缺一不可：await 期间取消是最常见的真实窗口）。
 *   本执行器**不能**做到的是 —— 中止已经发出的 HTTP 请求：Tauri 的 `invoke` 没有 signal/abort
 *   通道（providers 也只能在发起前检查），后端也没有取消命令。因此：
 *     · 在途请求会继续跑完，**可能仍然产生计费**；
 *     · 若取消落在落盘阶段，图片文件可能已经写入磁盘（本执行器不回收它）；
 *     · 请求返回后我们只是**丢弃**它，不落状态、不落记录。
 *   任何注释、文档与提交信息都不得声称"已中止在途请求"。
 */

import { generateImage, editImage } from "@/services/imageGeneration";
import type { ImageGenerationRequest } from "@/services/imageGeneration";
import { saveImage, type InputImageInfo } from "@/services/fileStorageService";
import { useCanvasStore } from "@/stores/canvasStore";
import { useFlowStore } from "@/stores/flowStore";
import type { ImageInputNodeData, CustomNodeData, CustomNode } from "@/types";
import { compositeWithMask } from "@/utils/imageMask";
import {
  buildImageGeneratorPrompt,
  getPromptMentionSourcesForNode,
} from "@/utils/promptMentions";
import type { ImageGeneratorNodeData, ImageGeneratorRunRecord } from "@/components/nodes/imageGeneratorConfig";
import {
  buildImageGenerationRequest,
  getImageApiProtocol,
  getImageApiProtocolConfig,
  getImageModelDisplayName,
  getResolvedOpenAIImageSize,
  validateGptImage2Size,
} from "@/components/nodes/imageGeneratorConfig";

const MAX_IMAGE_RUN_RECORDS = 8;

export interface ImageGenerationJobOptions {
  canvasId: string | null;
  /** 是否写入节点 runRecords（手动生成 true，工作流执行 false） */
  withRunRecords?: boolean;
  /**
   * 是否允许本执行器清除节点的 `data.queued` 排队标记。**默认 false**。
   *
   * 为什么必须由调用方决定（REQ-004 的复用后果，由独立审查 r1 实测发现）：
   * `data.queued` 是**队列路径专有**的状态 —— 它由 useImageGeneratorExecution 在入队时写下，
   * 只在"该节点确实还有 queued||running 任务"时才允许清除（见 queueStore 的标记不变式）。
   * 队列路径调用本执行器时，清除是合法的：正在跑的正是那个队列任务，标记该被它的启动消费掉。
   * 但工作流路径**不经过 enqueue**，它与队列任务无关：若它也清，就会在"该节点队列里仍有任务
   * 在等"时抹掉一份**合法**标记，让 UI 显示未排队、生成按钮重新可点 —— 用户继续点击只会被入队
   * 守卫拦下。改动前的 nodeExecutor 从不碰这个字段，所以工作流路径必须保持这一行为。
   * 因此改为显式开关：只有队列路径传 true。
   */
  clearQueuedMarker?: boolean;
  /** 取消信号（队列取消用） */
  signal?: AbortSignal;
  /** 覆盖节点参数（批量拆分时用 n=1） */
  dataOverride?: Partial<ImageGeneratorNodeData>;
}

export interface ImageGenerationJobResult {
  success: boolean;
  cancelled?: boolean;
  error?: string;
  outputImagePaths?: string[];
  outputThumbPaths?: string[];
}

function createRunId() {
  return `image-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimRunRecords(records: ImageGeneratorNodeData["runRecords"]) {
  return (records || []).slice(0, MAX_IMAGE_RUN_RECORDS);
}

function redactLargeImagePayloads(request: ImageGenerationRequest): ImageGenerationRequest {
  return {
    ...request,
    inputImages: request.inputImages?.map((image, index) =>
      `[image ${index + 1}: ${Math.round(image.length * 0.75).toLocaleString()} bytes]`
    ),
    maskImage: request.maskImage
      ? `[mask: ${Math.round(request.maskImage.length * 0.75).toLocaleString()} bytes]`
      : undefined,
  };
}

function getImageRunOutputJson(params: {
  success?: boolean;
  text?: string;
  metadata?: Record<string, unknown>;
  imagePaths?: string[];
  imageDataList?: string[];
  error?: string;
}) {
  return {
    success: Boolean(params.success),
    text: params.text,
    metadata: params.metadata,
    images: {
      count: params.imagePaths?.length || params.imageDataList?.length || 0,
      paths: params.imagePaths,
      inlineDataCount: params.imageDataList?.length,
    },
    error: params.error,
  };
}

// 读取节点（活动画布用 flowStore，其他画布用 canvasStore）
function readNodeFromCanvas(nodeId: string, canvasId: string | null): CustomNode | undefined {
  const { activeCanvasId } = useCanvasStore.getState();
  if (!canvasId || canvasId === activeCanvasId) {
    return useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  }
  const canvas = useCanvasStore.getState().canvases.find((c) => c.id === canvasId);
  return canvas?.nodes.find((n) => n.id === nodeId);
}

// 画布感知的节点数据更新
function updateNodeDataWithCanvas<T extends CustomNodeData>(
  nodeId: string,
  canvasId: string | null,
  nodeData: Partial<T>
) {
  const flow = useFlowStore.getState();
  const { activeCanvasId } = useCanvasStore.getState();
  flow.updateNodeData<T>(nodeId, nodeData);

  if (canvasId && canvasId !== activeCanvasId) {
    const canvasStore = useCanvasStore.getState();
    const canvas = canvasStore.canvases.find((c) => c.id === canvasId);
    if (canvas) {
      const updatedNodes = canvas.nodes.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, ...nodeData } } : node
      );
      useCanvasStore.setState((state) => ({
        canvases: state.canvases.map((c) =>
          c.id === canvasId ? { ...c, nodes: updatedNodes, updatedAt: Date.now() } : c
        ),
      }));
    }
  }
}

// 画布感知的提示词提及来源
function getMentionSources(nodeId: string, canvasId: string | null) {
  if (!canvasId) return [];
  const canvas = useCanvasStore.getState().canvases.find((c) => c.id === canvasId);
  if (!canvas) return [];
  return getPromptMentionSourcesForNode(canvas.nodes, canvas.edges, nodeId);
}

// 画布感知的连接输入解析（复用 nodeExecutor 的共享实现）
async function resolveConnectedInputs(nodeId: string, canvasId: string | null) {
  const { getConnectedInputDataFromCanvas, getConnectedImageDetailsFromCanvas } =
    await import("@/services/nodeExecutor");
  if (!canvasId) {
    const flow = useFlowStore.getState();
    const promptResult = await flow.getConnectedInputDataAsync(nodeId);
    const imageDetails = await flow.getConnectedImagesWithInfoAsync(nodeId);
    return { prompt: promptResult.prompt, connectedImageDetails: imageDetails };
  }
  const [promptResult, imageDetails] = await Promise.all([
    getConnectedInputDataFromCanvas(nodeId, canvasId),
    getConnectedImageDetailsFromCanvas(nodeId, canvasId),
  ]);
  return { prompt: promptResult.prompt, connectedImageDetails: imageDetails };
}

// 保存输入图片的元数据（回填路径，供生成记录引用）
async function persistInputImages(
  canvasId: string,
  connectedImageDetails: Array<{ id: string; fileName?: string; imageData?: string; imagePath?: string }>
): Promise<InputImageInfo[]> {
  const metadata: InputImageInfo[] = [];
  for (const img of connectedImageDetails) {
    let imagePath = img.imagePath;
    if (!imagePath && img.imageData) {
      try {
        const saved = await saveImage(img.imageData, canvasId, img.id, undefined, undefined, "input");
        imagePath = saved.path;
        updateNodeDataWithCanvas<ImageInputNodeData>(img.id, canvasId, { imagePath: saved.path });
      } catch (err) {
        console.warn("保存输入图片失败:", err);
      }
    }
    if (imagePath) {
      metadata.push({ path: imagePath, label: img.fileName || "输入图片" });
    }
  }
  return metadata;
}

export async function executeImageGeneration(
  nodeId: string,
  options: ImageGenerationJobOptions
): Promise<ImageGenerationJobResult> {
  const { canvasId, withRunRecords = true, clearQueuedMarker = false, signal, dataOverride } = options;

  /**
   * 只有队列路径才有权清 `data.queued`（见 ImageGenerationJobOptions.clearQueuedMarker 的说明）。
   * 工作流路径（clearQueuedMarker 未传 / false）必须原样保留该标记，否则会抹掉一份合法标记。
   */
  const queuedMarkerPatch = clearQueuedMarker ? { queued: false as const } : {};

  const node = readNodeFromCanvas(nodeId, canvasId);
  if (!node) {
    return { success: false, error: "节点不存在" };
  }

  const data: ImageGeneratorNodeData = { ...(node.data as ImageGeneratorNodeData), ...(dataOverride || {}) };
  const apiProtocol = getImageApiProtocol(data);
  const config = getImageApiProtocolConfig(apiProtocol);
  const model = data.model || config.defaultModel;

  const { prompt, connectedImageDetails } = await resolveConnectedInputs(nodeId, canvasId);
  const mentionSources = getMentionSources(nodeId, canvasId);
  const resolvedPrompt = buildImageGeneratorPrompt(data.prompt, prompt, mentionSources);
  const orderedImageDetails = [...connectedImageDetails].sort((a, b) => {
    return Number(!!b.hasMask && !!b.maskImageData) - Number(!!a.hasMask && !!a.maskImageData);
  });
  const inputImages = config.supportsImageInput
    ? orderedImageDetails.map((img) => img.imageData).filter(Boolean)
    : [];
  const maskImage = config.hasOpenAIImageControls
    ? orderedImageDetails.find((img) => img.hasMask && img.maskImageData)?.maskImageData
    : undefined;

  if (signal?.aborted) {
    return { success: false, cancelled: true };
  }

  if (!resolvedPrompt) {
    updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, {
      status: "error",
      error: "请连接提示词节点",
      ...queuedMarkerPatch,
    });
    return { success: false, error: "请连接提示词节点" };
  }

  const resolvedSize = getResolvedOpenAIImageSize({ ...data, model });
  const sizeValidationError =
    config.hasOpenAIImageControls && model === "gpt-image-2"
      ? validateGptImage2Size(resolvedSize)
      : undefined;
  if (sizeValidationError) {
    updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, {
      status: "error",
      error: sizeValidationError,
      ...queuedMarkerPatch,
    });
    return { success: false, error: sizeValidationError };
  }

  const startedAt = Date.now();
  const runId = createRunId();
  const operation = inputImages.length > 0 || maskImage ? "edit" : "generate";

  const baseRecord: ImageGeneratorRunRecord = {
    id: runId,
    startedAt,
    status: "loading",
    protocol: apiProtocol,
    protocolLabel: config.label,
    model,
    modelLabel: getImageModelDisplayName({ ...data, apiProtocol, model }),
    operation,
    input: {
      prompt: resolvedPrompt,
      imageCount: inputImages.length,
      imageLabels: orderedImageDetails.map((image, index) => image.fileName || `参考图 ${index + 1}`),
    },
  };

  // 按 id 更新（或补建）当前 run 记录
  const upsertRecord = (updates: Partial<ImageGeneratorRunRecord>) => {
    if (!withRunRecords) return;
    const current = readNodeFromCanvas(nodeId, canvasId)?.data as ImageGeneratorNodeData | undefined;
    const existing = current?.runRecords?.find((r) => r.id === runId) || baseRecord;
    updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, {
      runRecords: trimRunRecords([
        { ...existing, ...updates },
        ...(current?.runRecords || []).filter((record) => record.id !== runId),
      ]),
    });
  };

  updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, {
    status: "loading",
    // 只有队列路径清 `queued`：见 clearQueuedMarker 的说明（工作流路径必须保留该标记）。
    ...queuedMarkerPatch,
    error: undefined,
    ...(withRunRecords
      ? { runRecords: trimRunRecords([baseRecord, ...(data.runRecords || [])]) }
      : {}),
  });

  try {
    let finalPrompt = resolvedPrompt;
    if (!config.hasOpenAIImageControls && inputImages.length > 0) {
      const hasMaskInput = orderedImageDetails.some((img) => img.hasMask);
      if (hasMaskInput) {
        finalPrompt = `I'm providing two images: the original image and the same image with red highlighted areas marking the regions I want you to edit. Please edit ONLY the red-marked areas according to this instruction: ${resolvedPrompt}`;
      }

      for (const img of orderedImageDetails) {
        if (!img.hasMask || !img.maskImageData || !img.imageData) continue;
        try {
          inputImages.push(await compositeWithMask(img.imageData, img.maskImageData));
        } catch {
          inputImages.push(img.maskImageData);
        }
      }
    }

    const request = buildImageGenerationRequest(
      { ...data, apiProtocol, model },
      finalPrompt,
      inputImages.length > 0 ? inputImages : undefined,
      maskImage
    );

    // 将脱敏后的请求参数补进运行记录
    upsertRecord({
      input: {
        ...baseRecord.input,
        request: redactLargeImagePayloads(request),
      },
    });

    const response =
      operation === "edit"
        ? await editImage(request, config.providerKey, signal)
        : await generateImage(request, config.providerKey, signal);

    if (signal?.aborted) {
      updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, { status: "idle" });
      upsertRecord({ finishedAt: Date.now(), status: "error", error: "已取消" });
      return { success: false, cancelled: true };
    }

    if (response.error) {
      const finishedAt = Date.now();
      updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, {
        status: "error",
        error: response.error,
        errorDetails: response.errorDetails,
      });
      upsertRecord({
        finishedAt,
        durationMs: finishedAt - startedAt,
        status: "error",
        error: response.error,
        errorDetails: response.errorDetails,
        output: { metadata: getImageRunOutputJson({ success: false, error: response.error }) },
      });
      return { success: false, error: response.error };
    }

    if (!response.imageData) {
      const finishedAt = Date.now();
      updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, {
        status: "error",
        error: "未返回图片数据",
      });
      upsertRecord({
        finishedAt,
        durationMs: finishedAt - startedAt,
        status: "error",
        error: "未返回图片数据",
        output: { metadata: getImageRunOutputJson({ success: false, error: "未返回图片数据" }) },
      });
      return { success: false, error: "未返回图片数据" };
    }

    // 保存输出（带模型元数据与缩略图）；保存失败回退 base64
    let outputImagePaths: string[] | undefined;
    let outputThumbPaths: string[] | undefined;
    let base64Fallback: string[] | undefined;
    let firstPath: string | undefined;
    let firstThumb: string | undefined;
    let outputTextMetadata: Record<string, unknown> | undefined;

    if (canvasId) {
      try {
        const inputImagesMetadata = await persistInputImages(canvasId, connectedImageDetails);
        // REQ-006：这里是"检查取消"与"写回结果"之间最后一个 await 之后的位置之前的一步。
        // 取消可能恰好落在 await 期间（例如用户刚点了取消），因此**每个** await 返回后都要
        // 重新确认，否则会出现"已取消却仍把结果写进节点/运行记录"。
        if (signal?.aborted) {
          updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, { status: "idle" });
          upsertRecord({ finishedAt: Date.now(), status: "error", error: "已取消" });
          return { success: false, cancelled: true };
        }
        const imagesToSave = response.imageDataList?.length
          ? response.imageDataList
          : [response.imageData];
        const savedImages = await Promise.all(
          imagesToSave.map((imageData) =>
            saveImage(
              imageData,
              canvasId,
              nodeId,
              resolvedPrompt,
              inputImagesMetadata.length > 0 ? inputImagesMetadata : undefined,
              "generated",
              model
            )
          )
        );
        outputImagePaths = savedImages.map((image) => image.path);
        outputThumbPaths = savedImages
          .map((image) => image.thumb_path)
          .filter((p): p is string => Boolean(p));
        firstPath = outputImagePaths[0];
        firstThumb = savedImages[0]?.thumb_path;
        outputTextMetadata = getImageRunOutputJson({
          success: true,
          text: response.text,
          metadata: response.metadata,
          imagePaths: outputImagePaths,
        });
      } catch (saveError) {
        console.warn("文件保存失败，回退到 base64 存储:", saveError);
        base64Fallback = response.imageDataList?.length
          ? response.imageDataList
          : [response.imageData];
        outputTextMetadata = getImageRunOutputJson({
          success: true,
          text: response.text,
          metadata: response.metadata,
          imageDataList: base64Fallback,
        });
      }
    } else {
      base64Fallback = response.imageDataList?.length ? response.imageDataList : [response.imageData];
      outputTextMetadata = getImageRunOutputJson({
        success: true,
        text: response.text,
        metadata: response.metadata,
        imageDataList: base64Fallback,
      });
    }

    // REQ-006：写回成功结果之前的**最后一次**复查。
    // 上面的 persistInputImages / saveImage 都是真实 IPC 往返，取消完全可能落在其中；
    // 那时图片可能已经写到磁盘（无法撤回，见文件顶部的取消边界说明），但绝不能让节点状态与
    // 运行记录显示成功 —— 否则用户点了取消却看到"生成成功"，并且该结果会被画布持久化到
    // app-data.json。本复查只阻止"状态与记录写回"，不删除已写出的图片文件，也不宣称已中止
    // 在途请求。
    if (signal?.aborted) {
      updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, { status: "idle" });
      upsertRecord({ finishedAt: Date.now(), status: "error", error: "已取消" });
      return { success: false, cancelled: true };
    }

    const finishedAt = Date.now();
    updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, {
      status: "success",
      outputImage: firstPath ? undefined : base64Fallback?.[0],
      outputImagePath: firstPath,
      outputThumbPath: firstThumb,
      outputImages: firstPath ? undefined : base64Fallback,
      outputImagePaths,
      outputThumbPaths,
      error: undefined,
    });
    upsertRecord({
      finishedAt,
      durationMs: finishedAt - startedAt,
      status: "success",
      output: {
        text: response.text,
        metadata: outputTextMetadata,
        imagePaths: outputImagePaths,
        thumbPaths: outputThumbPaths,
        imageDataList: base64Fallback,
      },
    });

    return {
      success: true,
      outputImagePaths,
      outputThumbPaths,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    const finishedAt = Date.now();

    if (signal?.aborted) {
      updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, { status: "idle" });
      upsertRecord({ finishedAt, status: "error", error: "已取消" });
      return { success: false, cancelled: true };
    }

    updateNodeDataWithCanvas<ImageGeneratorNodeData>(nodeId, canvasId, {
      status: "error",
      error: message,
    });
    upsertRecord({
      finishedAt,
      durationMs: finishedAt - startedAt,
      status: "error",
      error: message,
      output: { metadata: getImageRunOutputJson({ success: false, error: message }) },
    });
    return { success: false, error: message };
  }
}

// 获取节点的批量数量：Gemini 协议按次数拆分任务；OpenAI 协议由 API 原生 n 处理
export function getImageBatchCount(data: ImageGeneratorNodeData): number {
  const apiProtocol = getImageApiProtocol(data);
  const config = getImageApiProtocolConfig(apiProtocol);
  if (config.hasOpenAIImageControls) {
    return 1; // 原生 n 参数一次请求
  }
  return Math.min(Math.max(data.n || 1, 1), 4);
}
