import { useCallback } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useFlowStore } from "@/stores/flowStore";
import { useQueueStore } from "@/stores/queueStore";
// 可见反馈通道：toast 是仓库既有的全局提示（非 React 侧调用入口，见 toastStore.ts:65-73），
// 在 App.tsx:259 的 ToastContainer 渲染。仅静态 import 一个只依赖 zustand 的小 store，
// 不新增模块图回边、不引入新依赖。
import { toast } from "@/stores/toastStore";
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
    // 可能已没有任何任务会去清它，节点就永久停在"排队中"、生成按钮永久禁用，重启也无法恢复
    // （队列里没有 queued 任务可供 REQ-001 的恢复逻辑处置）。
    //
    // ⚠ 这里曾经写作"执行器只在任务**开始**时写 queued:false，成功/失败/取消路径都不写"——
    // 那是**字面上错的**（已改正）：imageGenerationExecution.ts 里共有 **3 处**写 `queued:false`
    // —— :265-272 的任务开始那次，外加 :210-214（无提示词）与 :224-228（尺寸非法）两条**失败**路径。
    // 但这不改变本条论证：那两处失败写入**只有在任务已经真的入队并开始之后**才可达
    // （它们位于 executeImageGeneration 内部，必须先有一次成功的 enqueue 才会被调度到），
    // 而被守卫拒绝的这次点击根本没有产生任何任务，永远走不到执行器。所以"被拒的点击必须
    // 自己保证没有副作用"这个结论仍然成立，只是理由不能建立在"失败路径不写"之上。
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

    // 被整批拒绝时的处理：不改动节点状态（让被拒绝的点击在节点数据上完全无副作用），
    // 但**必须给出可见反馈**（F-R5-1）。
    //
    // 为什么这里不能只是 `return`（曾经的写法，是真实存在缺口）：存在一个正常路径下的窗口 ——
    // 一次点击 n=4、concurrency=1、**未暂停**：第 1 张图跑完时执行器已写
    // status:"success", queued:false（imageGenerationExecution.ts:265-267），而该节点**仍有 3 个
    // queued 任务**。此刻 ImageGeneratorNode.tsx:215 的 canRun 为 true、按钮可点，点击进到这里、
    // 被 (canvasId, nodeId) 守卫**正确拒绝**——但没有任何提示，用户看到的是"点了没反应"。
    // 拒绝本身是对的（那 3 个任务确实还在排队，不该再入队），错的是入口没有反馈。
    //
    // 选择"可见反馈"而不是"让按钮继续保持禁用"：后者要改 ImageGeneratorNode.tsx 的 canRun
    // （本轮允许路径之外），而且会与标记的**单向**不变式打架 —— 执行器在任务开始时写 queued:false
    // 是有意为之（标记语义是"排队等待中"，运行期由 status:"loading" 接管 UI）。所以缺口在入口
    // 反馈，不在按钮谓词。
    //
    // 用 toast（仓库既有的全局反馈通道，ToastContainer 挂在 App.tsx:259）：临时提示、
    // **不改布局/外观**、**不碰 canRun**、**不写节点数据字段**（写 data.error 会把一次被拒的点击
    // 变成可见的节点错误状态，并覆盖掉刚跑完那张图的 success 显示，那属于改变 UI 语义）。
    // 每次被拒的点击都给一条提示（不做去重）：这样"6 次点击被丢弃"就对应 6 次反馈，
    // 而不是只反馈第一条、让后续点击重新变成静默。
    if (!admitted) {
      toast.info("该节点仍有任务在排队中，本次点击未生效（可等待完成或用队列面板取消）");
      return;
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
