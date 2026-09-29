import { useCallback } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useFlowStore } from "@/stores/flowStore";
import { useQueueStore } from "@/stores/queueStore";
import { buildImageGeneratorPrompt, getPromptMentionSourcesForNode } from "@/utils/promptMentions";
import type { ImageGeneratorNodeData } from "@/components/nodes/imageGeneratorConfig";
import {
  getImageApiProtocol,
  getImageApiProtocolConfig,
  getResolvedOpenAIImageSize,
  validateGptImage2Size,
} from "@/components/nodes/imageGeneratorConfig";
import { getImageBatchCount } from "@/services/imageGenerationExecution";

/**
 * 图片生成节点的执行入口。
 * 点击"生成"不再直接调用 API，而是将任务加入生成队列（支持并发控制、取消、重试与批量拆分），
 * 由 queueStore 调度执行 imageGenerationExecution.executeImageGeneration。
 */
export function useImageGeneratorExecution(id: string, data: ImageGeneratorNodeData) {
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const getConnectedInputDataAsync = useFlowStore((s) => s.getConnectedInputDataAsync);
  const updateNodeData = useFlowStore((s) => s.updateNodeData);

  const model = data.model || getImageApiProtocolConfig(getImageApiProtocol(data)).defaultModel;
  const resolvedSize = getResolvedOpenAIImageSize({ ...data, model });
  const isOpenAIProtocol = data.apiProtocol === "openai-images";
  const sizeValidationError =
    isOpenAIProtocol && model === "gpt-image-2" ? validateGptImage2Size(resolvedSize) : undefined;

  const handleGenerate = useCallback(async () => {
    // 整批入队的 guard 上下文**必须在第一个 await 之前捕获**：本函数第一行会 await
    // getConnectedInputDataAsync（连了图片输入节点时是真实 IPC 往返，窗口可达数十毫秒），
    // 期间用户完全可能切换画布或点"复制画布"。守卫按 (canvasId, nodeId) 判定，
    // 若等到 await 之后才读 activeCanvasId，就会把任务归到一个用户已经离开的画布上，
    // 而节点状态仍写在当前活动的 flowStore 里 → 真正的活动画布上留下一个
    // "有活动任务却显示未排队"，或反过来让守卫误判另一个画布的同名节点。
    const queue = useQueueStore.getState();
    const canvasId = useCanvasStore.getState().activeCanvasId;

    // 快速校验提示词（连接或内联）
    const { prompt } = await getConnectedInputDataAsync(id);
    const mentionSources = getPromptMentionSourcesForNode(nodes, edges, id);
    const resolvedPrompt = buildImageGeneratorPrompt(data.prompt, prompt, mentionSources);

    if (!resolvedPrompt) {
      updateNodeData<ImageGeneratorNodeData>(id, {
        status: "error",
        error: "请连接提示词节点",
      });
      return;
    }

    if (sizeValidationError) {
      updateNodeData<ImageGeneratorNodeData>(id, {
        status: "error",
        error: sizeValidationError,
      });
      return;
    }

    const nodeLabel = data.label || "绘图生成";
    const modelLabel = data.model || model;
    const promptPreview = resolvedPrompt.length > 100 ? `${resolvedPrompt.slice(0, 100)}…` : resolvedPrompt;
    const batchCount = getImageBatchCount(data);

    // 入队可能被 store 层的重复入队守卫（REQ-002）拒绝：enqueue 返回 "" 表示"本次没有入队"。
    // 必须按"未发生"处理——否则一次被拒绝的点击仍会把节点写成 queued:true，而该节点此刻
    // 可能已没有任何任务会去清它（执行器只在任务**开始**时写 queued:false，成功/失败/取消
    // 路径都不写），节点就永久停在"排队中"、生成按钮永久禁用，重启也无法恢复
    // （队列里没有 queued 任务可供 REQ-001 的恢复逻辑处置）。
    let admitted = false;
    if (batchCount > 1) {
      for (let i = 0; i < batchCount; i++) {
        const jobId = queue.enqueue({
          nodeId: id,
          canvasId,
          nodeLabel,
          modelLabel,
          promptPreview,
          batchIndex: i + 1,
          batchTotal: batchCount,
          // 拆分后每次请求只生成一张
          dataOverride: { n: 1 },
        });
        if (jobId) admitted = true;
      }
    } else {
      admitted = Boolean(
        queue.enqueue({
          nodeId: id,
          canvasId,
          nodeLabel,
          modelLabel,
          promptPreview,
        })
      );
    }

    // 被整批拒绝时直接返回：不改动节点状态，让被拒绝的点击在 UI 上完全无副作用
    // （store 侧同时也把 queued 复位，双保险：即便有别的调用方忽略返回值也不会锁死节点）。
    if (!admitted) return;

    // 节点显示"排队中"，任务开始后由执行器置为 loading
    updateNodeData<ImageGeneratorNodeData>(id, {
      queued: true,
      status: "idle",
      error: undefined,
    });
  }, [id, data, nodes, edges, model, sizeValidationError, getConnectedInputDataAsync, updateNodeData]);

  return {
    handleGenerate,
    model,
    resolvedSize,
    sizeValidationError,
  };
}
