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

    const { activeCanvasId } = useCanvasStore.getState();
    const queue = useQueueStore.getState();
    const nodeLabel = data.label || "绘图生成";
    const modelLabel = data.model || model;
    const promptPreview = resolvedPrompt.length > 100 ? `${resolvedPrompt.slice(0, 100)}…` : resolvedPrompt;
    const batchCount = getImageBatchCount(data);

    if (batchCount > 1) {
      for (let i = 0; i < batchCount; i++) {
        queue.enqueue({
          nodeId: id,
          canvasId: activeCanvasId,
          nodeLabel,
          modelLabel,
          promptPreview,
          batchIndex: i + 1,
          batchTotal: batchCount,
          // 拆分后每次请求只生成一张
          dataOverride: { n: 1 },
        });
      }
    } else {
      queue.enqueue({
        nodeId: id,
        canvasId: activeCanvasId,
        nodeLabel,
        modelLabel,
        promptPreview,
      });
    }

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
