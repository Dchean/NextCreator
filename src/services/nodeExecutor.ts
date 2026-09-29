/**
 * 节点执行适配器
 * 为每种节点类型提供统一的执行接口
 */

import type { Edge, Node } from "@xyflow/react";
import type {
  CustomNodeData,
  ImageGeneratorNodeData,
  LLMContentNodeData,
} from "@/types";
import type { NodeExecutionResult } from "@/types/workflow";
import { shouldSkipNode } from "@/types/workflow";
import { useFlowStore } from "@/stores/flowStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { generateLLMContent } from "@/services/llmService";
// REQ-004：图片生成的**唯一实现**。工作流路径不再自己拼请求，改为委托给这个执行器，
// 从而同样获得运行记录/取消/批量/缩略图能力，并消除两份平行实现。
import { executeImageGeneration } from "@/services/imageGenerationExecution";
import { readImage } from "@/services/fileStorageService";
import { buildImageGeneratorPrompt, getPromptMentionSourcesForNode } from "@/utils/promptMentions";
import {
  buildLLMGenerationParams,
  getLLMApiProtocol,
} from "@/components/nodes/llmContentConfig";
import {
  isFileInputEdge,
  isImageInputEdge,
  isPromptInputEdge,
  getImageSlotSortKey,
} from "@/utils/connectionHandles";

// 自定义节点类型
type CustomNode = Node<CustomNodeData>;

interface ConnectedImageInfo {
  id: string;
  fileName?: string;
  imageData: string;
  imagePath?: string;
  hasMask?: boolean;
  maskImageData?: string;
  maskImagePath?: string;
}

function isImageOutputNodeType(type?: string): boolean {
  return type === "imageGeneratorNode";
}

function stripDataUrlPrefix(data: string) {
  const match = data.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return { mimeType: undefined, data };
  return { mimeType: match[1], data: match[2] };
}

function guessImageMimeType(data: string) {
  const parsed = stripDataUrlPrefix(data);
  if (parsed.mimeType) return parsed.mimeType;
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("iVBORw0KGgo")) return "image/png";
  if (data.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

function imageToLLMFile(imageData: string, index: number) {
  const parsed = stripDataUrlPrefix(imageData);
  const mimeType = parsed.mimeType || guessImageMimeType(imageData);
  const extension = mimeType.split("/")[1] || "png";
  return {
    data: parsed.data,
    mimeType,
    fileName: `image-${index + 1}.${extension}`,
  };
}

/**
 * 从指定画布获取连接的输入数据（异步版本，支持从文件加载图片）
 * 解决画布切换时数据读取错误的问题
 */
export async function getConnectedInputDataFromCanvas(
  nodeId: string,
  canvasId: string
): Promise<{
  prompt?: string;
  images: string[];
  files: Array<{ data: string; mimeType: string; fileName?: string }>;
}> {
  const { activeCanvasId } = useCanvasStore.getState();

  // 如果是当前活跃画布，使用 flowStore 的异步版本
  if (canvasId === activeCanvasId) {
    return useFlowStore.getState().getConnectedInputDataAsync(nodeId);
  }

  // 否则从 canvasStore 读取目标画布的数据
  const canvas = useCanvasStore.getState().canvases.find((c) => c.id === canvasId);
  if (!canvas) {
    return { images: [], files: [] };
  }

  const nodes = canvas.nodes as CustomNode[];
  const edges = canvas.edges as Edge[];
  // 按参考图槽位编号稳定排序，保证多图输入顺序稳定（非图片连线相对顺序不变）
  const incomingEdges = edges
    .filter((edge) => edge.target === nodeId)
    .sort((a, b) => getImageSlotSortKey(a) - getImageSlotSortKey(b));

  // 支持多个 prompt 输入，收集后拼接
  const prompts: string[] = [];
  const images: string[] = [];
  const files: Array<{ data: string; mimeType: string; fileName?: string }> = [];

  for (const edge of incomingEdges) {
    const sourceNode = nodes.find((n) => n.id === edge.source);
    if (!sourceNode) continue;
    const targetNode = nodes.find((n) => n.id === edge.target);

    if (isPromptInputEdge(edge, sourceNode, targetNode)) {
      // 从 prompt 输入端口连接的数据（支持多个，会自动拼接）
      if (sourceNode.type === "promptNode") {
        const data = sourceNode.data as { prompt?: string };
        if (data.prompt) prompts.push(data.prompt);
      } else if (sourceNode.type === "llmContentNode") {
        const data = sourceNode.data as { outputContent?: string };
        if (data.outputContent) prompts.push(data.outputContent);
      }
    } else if (isImageInputEdge(edge, sourceNode, targetNode)) {
      let imageData: string | undefined;
      if (sourceNode.type === "imageInputNode") {
        const data = sourceNode.data as { imageData?: string; imagePath?: string };
        // 优先从文件加载
        if (data.imagePath) {
          try {
            imageData = await readImage(data.imagePath);
          } catch (err) {
            console.warn("从文件加载图片失败:", err);
            imageData = data.imageData;
          }
        } else {
          imageData = data.imageData;
        }
      } else if (isImageOutputNodeType(sourceNode.type)) {
        const data = sourceNode.data as { outputImage?: string; outputImagePath?: string };
        // 优先从文件加载
        if (data.outputImagePath) {
          try {
            imageData = await readImage(data.outputImagePath);
          } catch (err) {
            console.warn("从文件加载图片失败:", err);
            imageData = data.outputImage;
          }
        } else {
          imageData = data.outputImage;
        }
      }
      if (imageData) {
        images.push(imageData);
      }
    } else if (isFileInputEdge(edge, sourceNode, targetNode)) {
      if (sourceNode.type === "fileUploadNode") {
        const data = sourceNode.data as { fileData?: string; mimeType?: string; fileName?: string };
        if (data.fileData && data.mimeType) {
          files.push({
            data: data.fileData,
            mimeType: data.mimeType,
            fileName: data.fileName,
          });
        }
      }
    } else {
      // 兼容旧连接
      if (sourceNode.type === "promptNode") {
        const data = sourceNode.data as { prompt?: string };
        if (data.prompt) prompts.push(data.prompt);
      } else if (sourceNode.type === "llmContentNode") {
        const data = sourceNode.data as { outputContent?: string };
        if (data.outputContent) prompts.push(data.outputContent);
      } else if (sourceNode.type === "imageInputNode") {
        const data = sourceNode.data as { imageData?: string; imagePath?: string };
        let imageData: string | undefined;
        if (data.imagePath) {
          try {
            imageData = await readImage(data.imagePath);
          } catch (err) {
            console.warn("从文件加载图片失败:", err);
            imageData = data.imageData;
          }
        } else {
          imageData = data.imageData;
        }
        if (imageData) images.push(imageData);
      } else if (isImageOutputNodeType(sourceNode.type)) {
        const data = sourceNode.data as { outputImage?: string; outputImagePath?: string };
        let imageData: string | undefined;
        if (data.outputImagePath) {
          try {
            imageData = await readImage(data.outputImagePath);
          } catch (err) {
            console.warn("从文件加载图片失败:", err);
            imageData = data.outputImage;
          }
        } else {
          imageData = data.outputImage;
        }
        if (imageData) images.push(imageData);
      } else if (sourceNode.type === "fileUploadNode") {
        const data = sourceNode.data as { fileData?: string; mimeType?: string; fileName?: string };
        if (data.fileData && data.mimeType) {
          files.push({ data: data.fileData, mimeType: data.mimeType, fileName: data.fileName });
        }
      }
    }
  }

  // 将多个 prompt 拼接成一个字符串，用换行符分隔
  const prompt = prompts.length > 0 ? prompts.join("\n\n") : undefined;
  return { prompt, images, files };
}

function getPromptMentionSourcesFromCanvas(nodeId: string, canvasId: string) {
  const { activeCanvasId } = useCanvasStore.getState();

  if (canvasId === activeCanvasId) {
    const { nodes, edges } = useFlowStore.getState();
    return getPromptMentionSourcesForNode(nodes, edges, nodeId);
  }

  const canvas = useCanvasStore.getState().canvases.find((c) => c.id === canvasId);
  if (!canvas) {
    return [];
  }

  return getPromptMentionSourcesForNode(canvas.nodes as CustomNode[], canvas.edges as Edge[], nodeId);
}

export async function getConnectedImageDetailsFromCanvas(
  nodeId: string,
  canvasId: string
): Promise<ConnectedImageInfo[]> {
  const { activeCanvasId } = useCanvasStore.getState();

  if (canvasId === activeCanvasId) {
    return useFlowStore.getState().getConnectedImagesWithInfoAsync(nodeId);
  }

  const canvas = useCanvasStore.getState().canvases.find((c) => c.id === canvasId);
  if (!canvas) {
    return [];
  }

  const nodes = canvas.nodes as CustomNode[];
  const edges = canvas.edges as Edge[];
  // 按参考图槽位编号稳定排序，保证多图输入顺序稳定（非图片连线相对顺序不变）
  const incomingEdges = edges
    .filter((edge) => edge.target === nodeId)
    .sort((a, b) => getImageSlotSortKey(a) - getImageSlotSortKey(b));
  const images: ConnectedImageInfo[] = [];

  for (const edge of incomingEdges) {
    const sourceNode = nodes.find((n) => n.id === edge.source);
    if (!sourceNode) continue;
    const targetNode = nodes.find((n) => n.id === edge.target);

    if (!isImageInputEdge(edge, sourceNode, targetNode)) continue;

    if (sourceNode.type === "imageInputNode") {
      const data = sourceNode.data as {
        imageData?: string;
        fileName?: string;
        imagePath?: string;
        hasMask?: boolean;
        maskImageData?: string;
        maskImagePath?: string;
      };
      let imageData: string | undefined;
      if (data.imagePath) {
        try {
          imageData = await readImage(data.imagePath);
        } catch (err) {
          console.warn("从文件加载图片失败:", err);
          imageData = data.imageData;
        }
      } else {
        imageData = data.imageData;
      }

      if (imageData) {
        let maskImageData: string | undefined;
        if (data.hasMask) {
          if (data.maskImagePath) {
            try {
              maskImageData = await readImage(data.maskImagePath);
            } catch (err) {
              console.warn("从文件加载蒙版失败:", err);
              maskImageData = data.maskImageData;
            }
          } else {
            maskImageData = data.maskImageData;
          }
        }

        images.push({
          id: sourceNode.id,
          fileName: data.fileName || `图片-${sourceNode.id.slice(0, 4)}`,
          imageData,
          imagePath: data.imagePath,
          hasMask: data.hasMask,
          maskImageData,
          maskImagePath: data.maskImagePath,
        });
      }
    } else if (isImageOutputNodeType(sourceNode.type)) {
      const data = sourceNode.data as { outputImage?: string; label?: string; outputImagePath?: string };
      let imageData: string | undefined;
      if (data.outputImagePath) {
        try {
          imageData = await readImage(data.outputImagePath);
        } catch (err) {
          console.warn("从文件加载图片失败:", err);
          imageData = data.outputImage;
        }
      } else {
        imageData = data.outputImage;
      }

      if (imageData) {
        images.push({
          id: sourceNode.id,
          fileName: data.label || `生成-${sourceNode.id.slice(0, 4)}`,
          imageData,
          imagePath: data.outputImagePath,
        });
      }
    }
  }

  return images;
}

/**
 * 画布感知的节点数据更新
 * 确保即使用户切换画布，状态也能正确更新到目标画布
 */
function updateNodeDataWithCanvas<T extends CustomNodeData>(
  nodeId: string,
  canvasId: string,
  data: Partial<T>
): void {
  const { activeCanvasId } = useCanvasStore.getState();

  if (canvasId === activeCanvasId) {
    // 目标画布是当前活跃画布，直接更新 flowStore
    const { updateNodeData } = useFlowStore.getState();
    updateNodeData<T>(nodeId, data);
  } else {
    // 目标画布不是当前活跃画布，只更新 canvasStore
    // 不要更新 flowStore，因为 flowStore 现在加载的是其他画布的数据
    const canvasStore = useCanvasStore.getState();
    const canvas = canvasStore.canvases.find((c) => c.id === canvasId);

    if (canvas) {
      const updatedNodes = canvas.nodes.map((node) => {
        if (node.id === nodeId) {
          return { ...node, data: { ...node.data, ...data } };
        }
        return node;
      });

      useCanvasStore.setState((state) => ({
        canvases: state.canvases.map((c) =>
          c.id === canvasId ? { ...c, nodes: updatedNodes, updatedAt: Date.now() } : c
        ),
      }));
    }
  }
}

/**
 * 执行图片生成节点
 *
 * REQ-004：这里**不再**自行拼装请求并分别调用 generateImage/editImage。修复前本函数与
 * src/services/imageGenerationExecution.ts 是两份平行实现（本文件约 160 行、那里约 290 行），
 * 后者覆盖 运行记录/取消/批量/缩略图，本函数则缺这些能力 —— 同一条业务流程两份实现，
 * 任何一侧修 bug 都要改两处。现在统一委托给 executeImageGeneration（唯一实现）。
 *
 * 复用带来的行为差异（**完整清单**，由独立审查 r1 的 before/after 9 场景矩阵核对后补全；
 * 早先版本只写了三条、漏了错误文案与 queued 写入两项，属穷举口吻的过度声称）：
 *   1) withRunRecords: false —— 工作流路径不写节点 runRecords（避免一次"运行全部"把每个图片
 *      节点的运行历史塞满），与改造前一致；
 *   2) clearQueuedMarker 不传（默认 false）—— 工作流路径**不碰** `data.queued`，与改造前一致。
 *      这一条是必需的：`data.queued` 是队列路径专有状态，工作流不经 enqueue、与该标记无关，
 *      若也清就会在"该节点队列里仍有任务在等"时抹掉一份合法标记（独立审查 r1 实测到的缺陷，
 *      已按 clearQueuedMarker 开关修正）；
 *   3) 返回值映射 —— executeImageGeneration 返回 {success, cancelled?, error?,
 *      outputImagePaths?, outputThumbPaths?}，而本路径的调用方（workflowEngine）需要
 *      {success, error}，节点渲染需要 outputImagePath/outputImagePaths。这里回读一次节点数据，
 *      把执行器刚写入的路径或 base64 回退映射成原有的 NodeExecutionResult.output 形状；
 *   4) 取消语义 —— 执行器已保证"取消后不写回结果"，这里只把 cancelled 映射成失败 + 「已取消」；
 *   5) 错误文案 —— 缺少提示词时由改造前的「缺少必需的提示词输入」变为执行器的
 *      「请连接提示词节点」（两条路径统一措辞；语义相同，属可接受的用户可见变化，如实记录）；
 *   6) provider 成功但未返回图片数据时：改造前本路径会**假成功**（写 status:"success" 却无产物），
 *      执行器会正确写入 error —— 这是复用带来的修复收益，不是回归。
 * 节点状态（loading/success/error/idle）与 outputImage* 字段仍由执行器按同一套
 * updateNodeDataWithCanvas 写入，因此既有节点渲染与 workflowEngine 的
 * result.success/error 消费方式都不变。
 */
async function executeImageGeneratorNode(
  node: CustomNode,
  canvasId: string,
  signal?: AbortSignal
): Promise<NodeExecutionResult> {
  const result = await executeImageGeneration(node.id, {
    canvasId,
    withRunRecords: false,
    signal,
  });

  if (result.cancelled) {
    return { success: false, error: "已取消" };
  }
  if (!result.success) {
    return { success: false, error: result.error || "执行失败" };
  }

  // 成功：执行器已把 outputImagePath/outputImagePaths（有落盘路径时）或 base64 回退
  // （outputImage/outputImages，落盘失败时）写入节点数据。这里回读一次以保持本路径原有的
  // NodeExecutionResult.output 形状（workflowEngine 目前只用 success/error，但下游节点与
  // 调试输出按这个形状读取）。
  const currentNode = readNodeFromCanvasSafe(node.id, canvasId);
  const outputData = (currentNode?.data || {}) as ImageGeneratorNodeData;
  return {
    success: true,
    output: {
      imageData: outputData.outputImage,
      imageDataList: outputData.outputImages,
      imagePath: outputData.outputImagePath,
      imagePaths: outputData.outputImagePaths,
    },
  };
}

/** 画布感知地读取节点；读不到时返回 undefined，避免把"成功但读不回"变成异常。
 *
 * 查找顺序必须与执行器自己的 readNodeFromCanvas（imageGenerationExecution.ts）**一致**：
 * 活动画布读 flowStore，非活动画布才读 canvasStore。反过来先读 canvasStore 会拿到**旧数据** ——
 * updateNodeDataWithCanvas 总是写 flowStore，只在"目标画布 != 活动画布"时才写 canvasStore，
 * 而 canvasStore 要到 App.tsx 的 800ms 防抖之后才被画布同步写入。工作流路径始终跑在活动画布上，
 * 因此必须先 flowStore。
 */
function readNodeFromCanvasSafe(nodeId: string, canvasId: string): CustomNode | undefined {
  try {
    const { activeCanvasId } = useCanvasStore.getState();
    if (!canvasId || canvasId === activeCanvasId) {
      return useFlowStore.getState().nodes.find((candidate) => candidate.id === nodeId);
    }
    return useCanvasStore
      .getState()
      .canvases.find((canvas) => canvas.id === canvasId)
      ?.nodes?.find((candidate) => candidate.id === nodeId) as CustomNode | undefined;
  } catch {
    // 画布不可用时回退到 flowStore
    return useFlowStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  }
}

/**
 * 执行 LLM 内容生成节点
 */
async function executeLLMContentNode(
  node: CustomNode,
  canvasId: string,
  signal?: AbortSignal
): Promise<NodeExecutionResult> {
  const data = node.data as LLMContentNodeData;
  // 使用画布感知的数据读取，解决画布切换问题（异步从文件加载图片）
  const { prompt, files, images } = await getConnectedInputDataFromCanvas(node.id, canvasId);
  const mentionSources = getPromptMentionSourcesFromCanvas(node.id, canvasId);
  const resolvedPrompt = buildImageGeneratorPrompt(data.prompt, prompt, mentionSources);
  const imageFiles = images.map(imageToLLMFile);
  const allFiles = [...files, ...imageFiles];
  const apiProtocol = getLLMApiProtocol(data);

  // 验证输入
  if (!resolvedPrompt && allFiles.length === 0) {
    updateNodeDataWithCanvas<LLMContentNodeData>(node.id, canvasId, {
      status: "error",
      error: "缺少必需的提示词、图片或文件输入",
    });
    return { success: false, error: "缺少必需的提示词、图片或文件输入" };
  }

  // 更新状态为加载中
  updateNodeDataWithCanvas<LLMContentNodeData>(node.id, canvasId, {
    status: "loading",
    error: undefined,
    outputContent: "",
  });

  try {
    // 检查中断
    if (signal?.aborted) {
      updateNodeDataWithCanvas<LLMContentNodeData>(node.id, canvasId, {
        status: "idle",
      });
      return { success: false, error: "已取消" };
    }

    const request = buildLLMGenerationParams(
      { ...data, apiProtocol },
      resolvedPrompt || "请分析输入内容",
      allFiles
    );
    const response = await generateLLMContent(request);

    // 检查中断
    if (signal?.aborted) {
      updateNodeDataWithCanvas<LLMContentNodeData>(node.id, canvasId, {
        status: "idle",
      });
      return { success: false, error: "已取消" };
    }

    if (response.error) {
      updateNodeDataWithCanvas<LLMContentNodeData>(node.id, canvasId, {
        status: "error",
        error: response.error,
        errorDetails: response.errorDetails,
      });
      return { success: false, error: response.error };
    }

    // 更新成功状态
    updateNodeDataWithCanvas<LLMContentNodeData>(node.id, canvasId, {
      status: "success",
      outputContent: response.content,
      error: undefined,
    });

    return {
      success: true,
      output: { content: response.content },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "执行失败";

    updateNodeDataWithCanvas<LLMContentNodeData>(node.id, canvasId, {
      status: "error",
      error: errorMessage,
    });

    return { success: false, error: errorMessage };
  }
}

/**
 * 节点执行器：按节点类型分发执行
 */
export class NodeExecutor {
  /**
   * 执行单个节点
   */
  async executeNode(
    node: CustomNode,
    canvasId: string,
    signal?: AbortSignal
  ): Promise<NodeExecutionResult> {
    const nodeType = node.type;

    // 检查是否应该跳过
    if (!nodeType || shouldSkipNode(nodeType)) {
      return { success: true }; // 跳过的节点视为成功
    }

    // 根据节点类型分发执行
    switch (nodeType) {
      case "imageGeneratorNode":
        return executeImageGeneratorNode(node, canvasId, signal);

      case "llmContentNode":
        return executeLLMContentNode(node, canvasId, signal);

      default:
        // 未知节点类型，跳过
        console.warn(`[NodeExecutor] 未知节点类型: ${nodeType}`);
        return { success: true };
    }
  }
}

// 导出单例
export const nodeExecutor = new NodeExecutor();
