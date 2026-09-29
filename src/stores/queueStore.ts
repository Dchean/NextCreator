import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriStorage } from "@/utils/tauriStorage";
import { executeImageGeneration } from "@/services/imageGenerationExecution";
// 标记的**读**必须是同步的（见 clearNodeQueuedMarker 的"先读后写"）：只有同步读到"标记本来就是
// falsy"才能在任何清除动作（含 import）之前提前返回，否则每个任务收尾都会产生一次"假变更"
// （flowStore.nodes / canvasStore.canvases 换新身份 → App.tsx:170 的 subscribe → 800ms 防抖 →
// updateCanvasData → persist → 落盘 app-data.json）。
// 这两个 import 不新增模块图边：queueStore 早已静态 import imageGenerationExecution，
// 而后者静态 import 了 flowStore 与 canvasStore；两者都不 import queueStore，无循环依赖。
import { useFlowStore } from "@/stores/flowStore";
import { useCanvasStore } from "@/stores/canvasStore";
import type { ImageGeneratorNodeData } from "@/components/nodes/imageGeneratorConfig";

export type QueueJobStatus = "queued" | "running" | "success" | "error" | "cancelled";

export interface QueueJob {
  id: string;
  nodeId: string;
  canvasId: string | null;
  /** 展示信息（入队时快照） */
  nodeLabel: string;
  modelLabel: string;
  promptPreview: string;
  status: QueueJobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** 批量拆分序号（1 起），无批量时为 undefined */
  batchIndex?: number;
  batchTotal?: number;
  /** 批量拆分时的参数覆盖 */
  dataOverride?: Partial<ImageGeneratorNodeData>;
}

interface QueueState {
  jobs: QueueJob[];
  concurrency: number;
  paused: boolean;
  isQueuePanelOpen: boolean;

  /**
   * 入队。返回新任务 id；被重复入队守卫（REQ-002）拒绝时返回空字符串，调用方按“未入队”处理。
   * 判定在 store 层同步完成：既覆盖同一次点击在同一个 tick 内的 N 次批量调用（整批放行），
   * 也覆盖 retry（queueStore.retry → 本方法）这条绕过 handleGenerate 的路径。
   */
  enqueue: (job: Omit<QueueJob, "id" | "status" | "createdAt">) => string;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  clearFinished: () => void;
  setConcurrency: (n: number) => void;
  togglePaused: () => void;
  setQueuePanelOpen: (open: boolean) => void;
  pump: () => void;
}

// 运行中的 AbortController（不持久化）
const abortControllers = new Map<string, AbortController>();
// 防止重入 pump
let pumping = false;

// —— 重复入队守卫（REQ-002）——
// 背景：批量生成的 N 张图会**在同一次同步调用里连续调用 N 次 enqueue**
// （useImageGeneratorExecution 的 `for (i < batchCount)`），而"确实又点了一次生成"同样是若干次
// enqueue 调用。因此守卫既不能逐条判定（会把一次点击的整批截断成 1 张），也不能只看 running
// （排队中的任务还不是 running）。判定必须在 store 层同步完成，才能同时覆盖三条路径：
//   ① 同一次点击的批量调用；② 互不 await 的连点；③ retry（queueStore.retry → enqueue，
//   完全不经过 handleGenerate，入口级守卫拦不住）。
//
// 判定模型：把"一次点击的整批调用"当作一个不可分的整体，用**批次链**识别"这一批还没交完"。
// 批量调用带 batchIndex（1 起）与 batchTotal，且同一次点击的循环产出的是**连续递增**的
// batchIndex（1,2,…,batchTotal）。于是：
//   · 一次点击的第 1 次调用：该作用域没有 active 任务 → 放行，并记下"这一批的下一个序号"；
//   · 同一次点击的第 2..N 次调用：序号恰好等于"下一个序号"且批次形状一致 → 同一批 → 放行；
//   · 新一次点击的第 1 次调用：序号回到 1，与"下一个序号"（上一批已交到的 N+1）对不上
//     → 不是这一批的续传 → 走通用规则：该作用域已有 active 任务 → 拒绝，任务数不增长。
// 续传判定是纯结构判定（序号连续 + 形状一致），不依赖计时：同一批的调用天然连续递增；
// 而任何"新的一次点击"都从 1 重新开始、必然对不上已推进到 N+1 的链。两个方向都不会误判：
//   · 同一次点击的整批不会被自己截断（整批完整入队）；
//   · 连点与重复 retry 不会被放行（第二次点击的序号/无序号都构不成续传）。
// 链的清理（LOW-4）：整批交完、入队被拒（= 新的一击，本次调用永不续传）、以及交付后该作用域
// 没有活动任务时，都立即删除该链。链只在"同一次点击的 2..N 次调用"之间有用，任何更长的存活
// 都只会带来误判（被打断的旧链被下一次点击的第 k 次调用续上 → 多放行任务）与内存增长。
//
// 判定范围严格限定为**同一画布同一节点**（canvasId + nodeId）的 active 任务（queued 或 running）；
// 历史任务（success/error/cancelled）一律不参与判定，所以批次跑完后能正常再生成、失败任务能正常
// retry。按画布区分是必须的：canvasStore.duplicateCanvas 复制画布时原样保留 node.id，两个画布上
// 存在同名节点，只按 nodeId 判定会让另一个画布上的合法生成被静默拒绝（见 guardScopeKey）。
// 另需注意：守卫**不看 paused**。暂停时生成按钮依旧可点击（canRun 不检查 paused），
// 若在暂停时跳过判定，连点就会在暂停期间累积并发任务。
//
// 被拒绝的一击必须"无副作用"：enqueue 返回 ""（唯一的生产调用方 useImageGeneratorExecution
// 已按返回值处理），并且复核该节点的 queued 标记（clearNodeQueuedMarkerIfNoActiveJob）——但只在
// **该节点确实没有 queued||running 任务时**才清，见文件末的标记不变式：拒绝往往正是因为同一次
// 连点里被放行的那一击刚写下合法标记，无条件清会把它抹掉。
// （该次复核在当前语义下恒为 no-op —— 能进这个分支就说明该 nodeId 已有活动任务，而谓词看的正是
//   这一点；它作为防御性兜底保留，真正阻止那次写入的是 hook 的 admitted 守卫。见分支内注释与
//   文件末的不变式注释。）
//
// 注意"复核的判定作用域"与上面的"守卫作用域"**不是同一个**，这是有意的：守卫按 (canvasId, nodeId)
// 判定（两个画布上的同名节点是各自独立的入队目标），而标记的复核与清除落点都按 **nodeId** ——
// 二者必须同口径：清除覆盖该 nodeId 的**所有**载体（flowStore 的当前节点 + 每个含该 nodeId 的
// 画布副本），若谓词按更窄的 (canvasId, nodeId) 判定，画布 A 的任务收尾就会抹掉画布 B 上同名
// 节点的合法标记；若清除只覆盖一张副本，另一张落盘的副本会永久留在 true（REQ-001 的锁）。
// 详见 clearNodeQueuedMarker / clearNodeQueuedMarkerIfNoActiveJob 的注释。
interface BatchChain {
  /** 批次形状键：批量总数 + 入队内容，用于确认"仍是同一批"（不同批量或不同内容不得续传）。 */
  key: string;
  /** 这一批下一个应当到来的 batchIndex。 */
  nextIndex: number;
}

const batchChains = new Map<string, BatchChain>();

// retry 会把原任务的 batchIndex/batchTotal 一并复制过来，于是"重试批量中的某个任务"在字段上
// 与"批量点击的第 k 次调用"无法区分。若不区分，重试 #1 会开出一条批次链，紧接着重试同批的
// 另一个任务就可能被误判成"这一批的续传"而多入队一个任务。retry 与 enqueue 同在本文件，
// 因此由 retry 在调用 enqueue 期间置一个来源标记：来自 retry 的调用永远按"独立的一次新任务"
// 处理——既不参与续传，也不开启批次链（判定本身仍在 enqueue 内同步完成）。
let enqueueOriginRetry = false;

function consumeRetryOrigin(): boolean {
  const fromRetry = enqueueOriginRetry;
  enqueueOriginRetry = false;
  return fromRetry;
}

function isActiveJob(job: QueueJob): boolean {
  return job.status === "queued" || job.status === "running";
}

/**
 * 守卫与批次链的作用域键 = **(canvasId, nodeId)**。
 *
 * 为什么不能只用 nodeId：canvasStore.duplicateCanvas 用 `{...canvas}` 复制画布，**原样保留
 * node.id**，所以"复制画布"之后两个画布上存在 id 相同的节点，而两边的"生成"按钮都可用、
 * 都是合法的独立操作。只按 nodeId 判定会把另一个画布上的同名节点当成同一个节点：
 * 在画布 X 上生成之后，切到画布 Y 点生成会被静默拒绝（Y 一个任务都进不去，
 * 叠加调用方无条件写 queued:true 还会把 Y 的节点锁成"排队中"）。
 *
 * canvasId 可能为 null（无画布上下文的旧任务/测试路径）：null 与 null 视为同一作用域，
 * 与具体画布 id 严格相等比较，两者不会互相串味。
 */
function guardScopeKey(canvasId: string | null, nodeId: string): string {
  return `${canvasId ?? ""}\u0002${nodeId}`;
}

/**
 * 只看**同一画布同一节点**的排队中/运行中任务。
 * 历史任务不参与判定；其他画布上的同名节点也不参与（它们是不同的节点）。
 */
function hasActiveJobForNode(jobs: QueueJob[], nodeId: string, canvasId: string | null): boolean {
  return jobs.some(
    (job) => job.nodeId === nodeId && (job.canvasId ?? null) === canvasId && isActiveJob(job)
  );
}

/** 批次形状：同一次点击的批量循环里，这些字段逐次完全相同。 */
function batchShapeKey(job: Omit<QueueJob, "id" | "status" | "createdAt">): string {
  return [
    job.batchTotal ?? 1,
    job.canvasId ?? "",
    job.nodeLabel,
    job.modelLabel,
    job.promptPreview,
    job.dataOverride ? JSON.stringify(job.dataOverride) : "",
  ].join("\u0001");
}

/** 本次调用是否属于"正在交付中的那一批"（同一次点击的整批续传）。 */
function isBatchContinuation(
  job: Omit<QueueJob, "id" | "status" | "createdAt">,
  scopeKey: string
): boolean {
  // 单张路径没有 batchIndex（无批量时为 undefined），一次点击只调用一次 enqueue，不存在续传。
  if (job.batchIndex == null) return false;
  const chain = batchChains.get(scopeKey);
  if (!chain) return false;
  return chain.key === batchShapeKey(job) && job.batchIndex === chain.nextIndex;
}

function createJobId() {
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// —— 重启恢复（REQ-001）——
// 持久化意图：partialize 写入除 running 以外的任务，所以重启后遗留的“未完成”任务
// 只有一种形态：status === "queued"（running 从不落盘，不存在需要标记为中断的运行中任务，
// 旧实现去恢复 running 因此永远命中不到，是死分支）。恢复目标与持久化意图严格对应。
const RECOVERY_READY_TIMEOUT_MS = 600;

function isRecoverableJob(job: QueueJob): boolean {
  return job.status === "queued";
}

// 恢复只执行一次：重复水合不得把同一批任务反复派发（崩溃循环防线之一）
let recoveryStarted = false;

/**
 * 等待画布就绪：canvasStore 是另一个持久化 store，重启后可能晚于队列水合完成；
 * 活动画布的节点还要更晚一步 —— 它们在 App.tsx:121-163 的 React effect 里由
 * setNodes 灌进 flowStore（flowStore 自身不持久化，重启后是空的）。
 *
 * 所以"就绪"不能只看 _hasHydrated：那只说明 localStorage 读完了，活动画布的节点
 * 可能还没进 flowStore。若在这里放行，执行器会读到空的 flowStore，把"画布还没加载"
 * 误判成"节点不存在"，任务直接落到 error 终态 —— REQ-001 的恢复就此静默失败。
 *
 * 有界等待：超时也必须放行，保证任务不会滞留在 queued。等待期间节点标记已被清除，
 * 用户在等待窗口里点生成是完全合法的（那条点击会正常入队），本函数不再介入其状态。
 */
async function waitForCanvasReady(jobs: QueueJob[]): Promise<void> {
  const [{ useFlowStore }, { useCanvasStore }] = await Promise.all([
    import("@/stores/flowStore"),
    import("@/stores/canvasStore"),
  ]);

  const isNodeResolvable = (
    job: QueueJob,
    activeCanvasId: string | null,
    canvases: ReturnType<typeof useCanvasStore.getState>["canvases"],
    flowNodes: ReturnType<typeof useFlowStore.getState>["nodes"]
  ) => {
    // 任务所属画布：没有标注（null）时无法区分，退化为"任一画布上可解析即可"。
    if (!job.canvasId || job.canvasId === activeCanvasId) {
      return flowNodes.some((n) => n.id === job.nodeId);
    }
    const canvas = canvases.find((c) => c.id === job.canvasId);
    // 非活动画布：执行器从 canvasStore 读节点（imageGenerationExecution.ts:92-99），
    // 但持久化副本里一定有这个节点 —— 节点只可能被用户删除，不会被水合丢掉。
    // 必须用"是活动画布吗"来选副本，而不是"flowStore 里恰好有同名 id 吗"：
    // 复制画布会保留 node.id，用后者判定会把另一画布上的同名节点误当成已就绪。
    return Boolean(canvas?.nodes.some((n) => n.id === job.nodeId));
  };

  const deadline = Date.now() + RECOVERY_READY_TIMEOUT_MS;
  for (;;) {
    const { activeCanvasId, canvases, _hasHydrated } = useCanvasStore.getState();
    const flowNodes = useFlowStore.getState().nodes;
    // 必须等画布水合完成，否则 canvases 还是空的，非活动画布的任务必然解析不到。
    if (_hasHydrated && jobs.every((job) => isNodeResolvable(job, activeCanvasId, canvases, flowNodes))) {
      return;
    }
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * 重启后恢复遗留的 queued 任务：清掉节点上残留的 queued 标记，等画布就绪后交给调度器执行。
 * 恢复放在 store 层（onRehydrateStorage），而不是 App 的 useEffect —— 只走水合路径也能恢复。
 * 防崩溃循环：① 每个进程只恢复一次；② 恢复不重试、不重新入队，任务失败即落到 error 终态；
 * ③ 终态任务不再匹配 isRecoverableJob，即使再次重启也不会被反复执行。
 */
function recoverPersistedQueuedJobs() {
  if (recoveryStarted) return;
  recoveryStarted = true;

  const recovered = useQueueStore.getState().jobs.filter(isRecoverableJob);
  if (recovered.length === 0) return;

  // 残留的 queued 标记是重启前入队时写下的，会导致节点永久禁用（按钮不可用、显示“排队中”）；
  // 恢复后该标记由调度器/执行器重新接管，所以先显式清除。
  // 必须用"只清"的 clearNodeQueuedMarker（这里是有意的无条件清除）：清除的目标是**节点数据的
  // 载体**（运行时 flowStore 与持久化的 canvasStore 两份），而不是某个具体任务所属的那一份 ——
  // job.canvasId 只是任务的来源标注，拿它去反推"该清哪份副本"在重启场景里正好会漏掉落盘的那一份
  // （flowStore 不持久化，重启后为空；画布副本才是 App.tsx:154 setNodes 载入的那一份）。
  // 被清掉的是**上一个进程**留下的陈旧标记，而刚水合的这批 queued 任务由调度器与执行器重新接管
  // （执行器启动时就写 queued:false），所以这里清掉不会破坏标记不变式。
  for (const job of recovered) {
    clearNodeQueuedMarker(job.nodeId);
  }

  void waitForCanvasReady(recovered)
    .catch(() => undefined)
    .then(() => {
      // 真正派发；节点确实不存在时执行器会返回“节点不存在”，任务落到 error 而非卡在 queued。
      useQueueStore.getState().pump();

      // 派发后复核一次：任务此时已从 queued 变成 running（或已落到终态），节点上的 queued
      // 标记若仍为 true，只可能是被**旧快照**重新写回来的 —— App 载入画布时用的是
      // canvasStore 里的节点数组，若那份数组在恢复清标记之前就已取出（例如挂起的画布切换
      // 先保存了旧 flowStore 快照），它会把旧值带回 flowStore 与画布，于是 REQ-001 的症状
      // 再次出现。只在"该节点没有仍在排队等待的任务"时清：这样既不会抹掉用户在这个
      // 时间窗内新点的一次生成（它会产生一个新的 queued 任务），也不会干扰正在运行的任务
      // （执行器启动时本就写 queued:false，标记语义与它一致）。
      // 这一遍是**脆弱**的：它依赖"清标记 → 派发 → 复核"的时序，不要删、也不要提前。
      for (const job of recovered) {
        clearNodeQueuedMarkerIfNoActiveJob(job.nodeId);
      }
    });
}

export const useQueueStore = create<QueueState>()(
  persist(
    (set, get) => ({
      jobs: [],
      concurrency: 2,
      paused: false,
      isQueuePanelOpen: false,

      enqueue: (job) => {
        // —— 重复入队守卫（REQ-002）——
        // 同步判定，不依赖 await/微任务，所以同一次点击的批量调用、互不 await 的连点、
        // 以及 retry 这条绕过 handleGenerate 的路径全部被覆盖；paused 不参与判定（见上方注释）。
        const jobs = get().jobs;
        const fromRetry = consumeRetryOrigin();
        // 判定作用域 = (canvasId, nodeId)：复制画布后两画布存在同名节点，必须分别判定。
        const scopeKey = guardScopeKey(job.canvasId ?? null, job.nodeId);
        let batchComplete = false;

        if (!fromRetry && isBatchContinuation(job, scopeKey)) {
          // 同一次点击的整批续传：这一批还没交完，继续放行，并把批次链推进一格。
          const chain = batchChains.get(scopeKey)!;
          chain.nextIndex = (job.batchIndex ?? 0) + 1;
          // LOW-4：这一批已经交完（最后一个 job）→ 链没有保留价值，立即清掉。
          // 链的用途仅是"识别同一次点击的 2..N 次调用"，交完后任何新调用都必须回到
          // "该节点已有 active 任务 → 拒绝"的通用规则；先清链让该规则与链的状态无关。
          if ((job.batchIndex ?? 0) >= (job.batchTotal ?? 1)) {
            batchChains.delete(scopeKey);
            batchComplete = true;
          }
        } else if (hasActiveJobForNode(jobs, job.nodeId, job.canvasId ?? null)) {
          // 同一画布同一节点已有排队中/运行中的任务，且本次调用不是同一批的续传 → 重复入队，拒绝。
          // 只比对 active 任务；历史任务（success/error/cancelled）不参与，保证批次跑完后
          // 还能再生成、失败任务还能 retry。
          //
          // 拒绝即"本次点击没有发生"：任务不会被调度、也不会有任何执行路径来清除节点的
          // queued 标记，所以这里复核一次标记（防永久锁）。
          //
          // ⚠ 诚实说明（避免文档声称代码没做的事）：本次复核在当前语义下**恒为 no-op**。
          // 进入本分支的前提就是 hasActiveJobForNode(jobs, nodeId, canvasId) 为真，即该 nodeId
          // 上已有一个 queued||running 任务；而复核谓词按 **nodeId** 判定（比守卫更宽，见文件末
          // 的不变式注释），且两次判定之间没有任何 await（同一个同步调用栈）——于是谓词必然早退。
          // 它是一条**防御性的 no-op**：保留它是因为"调用方先写 queued:true 而没有任何执行路径
          // 去清"这类第三方用法一旦出现，这里是唯一的兜底；真正阻止那次写入的是 hook 的
          // admitted 守卫（enqueue 返回空串时不写 queued:true，见 useImageGeneratorExecution.ts）。
          // 复核必须是**条件**的（clearNodeQueuedMarkerIfNoActiveJob，而非无条件清除）：无条件清
          // 会破坏标记不变式——在"快速连点"里第 2 次点击被拒时，第 1 次点击的 queued:true 往往
          // 刚写下、而它的任务正合法地停在 queued（并发额度被别人占着），清掉它就会让 UI 显示
          // "未排队"、按钮可用，可节点确实有任务在等待，用户继续点击只会被静默丢弃。
          clearNodeQueuedMarkerIfNoActiveJob(job.nodeId);
          // LOW-4：被拒绝说明"这一批"已经不可能再续传（该节点已有活动任务，代表这是新的一击）。
          // 残留的旧链（比如上一次点击只交了 1 个就被打断，nextIndex 停在 2）会被这一击的
          // 第 2 次调用当成续传而多放行一个任务，所以在这里把链清掉：本次调用永远不能续传，
          // 也就不会留下一条"等着被下一次点击的第 k 次调用续上"的陈旧链。
          batchChains.delete(scopeKey);
          return "";
        } else if (!fromRetry && job.batchIndex === 1 && (job.batchTotal ?? 1) > 1) {
          // 新一轮批量点击的第一次调用：登记批次链，供同批的 2..N 次调用续传。
          // 判定作用域 = (canvasId, nodeId)：复制画布后两画布存在同名节点，必须分别判定。
          batchChains.set(scopeKey, {
            key: batchShapeKey(job),
            nextIndex: 2,
          });
        } else {
          // 单张路径（无批量）或 retry 调用：清理该作用域的陈旧批次链，避免旧链被后续调用续上。
          batchChains.delete(scopeKey);
        }

        const id = createJobId();
        const newJob: QueueJob = { ...job, id, status: "queued", createdAt: Date.now() };
        set((state) => ({
          jobs: [newJob, ...state.jobs].slice(0, 200),
        }));
        get().pump();
        // LOW-4：整批交付完成（或被调度器立刻跑完）后链已无用 → 清掉，避免模块级 Map
        // 无上限增长、也避免"中途被打断的旧链"被很久之后的同形状点击误认成续传。
        if (batchComplete || !hasActiveJobForNode(get().jobs, job.nodeId, job.canvasId ?? null)) {
          batchChains.delete(scopeKey);
        }
        return id;
      },

      cancel: (id) => {
        const job = get().jobs.find((j) => j.id === id);
        if (!job) return;

        if (job.status === "queued") {
          set((state) => ({
            jobs: state.jobs.map((j) =>
              j.id === id ? { ...j, status: "cancelled", finishedAt: Date.now() } : j
            ),
          }));
          // 同步取消同节点的排队状态（清理该 nodeId 的**所有**载体，理由见 clearNodeQueuedMarker）。
          // 这里用**条件**版本而不是无条件清除：刚置为 cancelled 的这个任务已不在 active 集合里，
          // 谓词（按 nodeId 判定）因此只会在"该节点真的没有其它 queued||running 任务"时放行。
          // 不能无条件清：复制画布场景下同一 nodeId 可以在**两张画布**上各有一个活动任务（守卫按
          // (canvasId, nodeId) 判定），无条件清会把另一张画布上那份**合法**标记抹掉——那正是
          // 不变式禁止的"UI 显示未排队、实际有任务在等"。而条件分支的方向是安全的：该清时照样清
          // （否则就是永久锁），不该清时保持原状，等那个任务收尾时由 pump 的 .finally 复核清除。
          clearNodeQueuedMarkerIfNoActiveJob(job.nodeId);
        } else if (job.status === "running") {
          // 中断执行器：结果会被丢弃，节点恢复 idle。
          abortControllers.get(id)?.abort();
          // 这里**不做**标记复核（不是"做了但清不掉"，而是根本没有这一步）：abort 是异步的，
          // 本行执行时该任务仍是 running 且仍在 jobs 里，任何"按活动任务判定"的复核都必然把
          // **被取消的这个任务自己**算作活动任务 → 恒为 no-op。所以"取消能复位标记"从来不是
          // 本分支的功劳，而是**一步依赖**：任务真正离开 active 集合后，由 pump 的 .finally
          // 收尾复核清除（覆盖执行器在 IPC 窗口内命中 aborted 时直接 return {cancelled:true}、
          // 既不写 queued:false 也不更新节点状态的那条路径）。
          // 曾经在这里放过一次 clearNodeQueuedMarkerIfNoActiveJob 调用，它是可证明的死代码，
          // 只会让读者误以为存在"cancel + finally"的两步机制，故删除（见文件末的不变式注释）。
        }
      },

      retry: (id) => {
        const job = get().jobs.find((j) => j.id === id);
        if (!job) return;
        // 标记来源：retry 会复制 batchIndex/batchTotal，不能让这批字段把重试误认成批量续传。
        enqueueOriginRetry = true;
        try {
          get().enqueue({
            nodeId: job.nodeId,
            canvasId: job.canvasId,
            nodeLabel: job.nodeLabel,
            modelLabel: job.modelLabel,
            promptPreview: job.promptPreview,
            batchIndex: job.batchIndex,
            batchTotal: job.batchTotal,
            dataOverride: job.dataOverride,
          });
        } finally {
          // 即使 enqueue 抛错也要复位，避免标记泄漏到下一次普通入队。
          enqueueOriginRetry = false;
        }
      },

      clearFinished: () => {
        set((state) => ({
          jobs: state.jobs.filter((j) => j.status === "queued" || j.status === "running"),
        }));
      },

      setConcurrency: (n) => {
        const clamped = Math.min(Math.max(Math.round(n), 1), 4);
        set({ concurrency: clamped });
        get().pump();
      },

      togglePaused: () => {
        set((state) => ({ paused: !state.paused }));
        get().pump();
      },

      setQueuePanelOpen: (open) => set({ isQueuePanelOpen: open }),

      pump: () => {
        if (pumping) return;
        pumping = true;

        const step = () => {
          const state = get();
          const runningCount = state.jobs.filter((j) => j.status === "running").length;
          if (state.paused || runningCount >= state.concurrency) {
            pumping = false;
            return;
          }

          const next = [...state.jobs]
            .reverse()
            .find((j) => j.status === "queued");
          if (!next) {
            pumping = false;
            return;
          }

          set((s) => ({
            jobs: s.jobs.map((j) =>
              j.id === next.id
                ? { ...j, status: "running", startedAt: Date.now(), error: undefined }
                : j
            ),
          }));

          const controller = new AbortController();
          abortControllers.set(next.id, controller);

          void executeImageGeneration(next.nodeId, {
            canvasId: next.canvasId,
            withRunRecords: true,
            signal: controller.signal,
            dataOverride: next.dataOverride,
          })
            .then((result) => {
              const finalStatus: QueueJobStatus = result.cancelled
                ? "cancelled"
                : result.success
                  ? "success"
                  : "error";
              set((s) => ({
                jobs: s.jobs.map((j) =>
                  j.id === next.id
                    ? {
                        ...j,
                        status: finalStatus,
                        finishedAt: Date.now(),
                        error: result.error,
                      }
                    : j
                ),
              }));
            })
            .catch((e) => {
              set((s) => ({
                jobs: s.jobs.map((j) =>
                  j.id === next.id
                    ? {
                        ...j,
                        status: "error",
                        finishedAt: Date.now(),
                        error: e instanceof Error ? e.message : String(e),
                      }
                    : j
                ),
              }));
            })
            .finally(() => {
              abortControllers.delete(next.id);
              // 任务离开 active 集合（success/error/cancelled 三者都不是 queued||running）→ 按标记
              // 不变式复核该节点的标记。**必须无条件调用、不能只在 cancelled 时调**：执行器的取消
              // 路径（在 IPC 窗口内命中 signal.aborted 时直接 return {cancelled:true}）既不写
              // queued:false，也不更新节点状态，只有这一步能把 hook 写下的 queued:true 复位；否则
              // 节点永久卡在"排队中"。这也是取消（cancel 的 running 分支）复位标记的**唯一**一步
              // ——那里刻意不做复核（那一刻被取消的任务仍是 running，复核恒为 no-op）。
              // 调用自身是条件清除（按 nodeId 判定，与清除落点同一作用域），所以无条件调用不会
              // 误伤：该节点若还有 queued||running 任务（例如用户在这个时间窗里新点的一次生成，
              // 或另一个画布上的同名节点），它什么都不做。
              clearNodeQueuedMarkerIfNoActiveJob(next.nodeId);
              step();
            });

          // 递归补位：并发未满时继续取下一个任务
          setTimeout(step, 0);
        };

        step();
      },
    }),
    {
      name: "generation-queue",
      storage: createJSONStorage(() => tauriStorage),
      // 持久化意图：running 任务无法跨进程恢复（其 AbortController 不落盘），只留下未开始的任务。
      // 恢复逻辑（recoverPersistedQueuedJobs）处理的正是 queued，两者严格对应，不存在不可达分支。
      partialize: (state) => ({
        jobs: state.jobs.filter((j) => j.status !== "running"),
        concurrency: state.concurrency,
      }),
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            console.error("队列水合失败，跳过重启恢复:", error);
            return;
          }
          // 已完成水合：处置遗留 queued 任务并拉起调度器（pump 只从这里和 enqueue 等入口触发，
          // 否则重启后没人派发，任务会永远停在 queued）。
          recoverPersistedQueuedJobs();
        };
      },
    }
  )
);

/**
 * 清除节点上的 queued 标记（**只清，绝不置位**）。
 *
 * 清除的**作用域 = nodeId**（与判定谓词完全同一处作用域解析，见 clearNodeQueuedMarkerIfNoActiveJob）：
 * 标记有两类载体，全部要清 ——
 *   · flowStore.nodes：编辑现场，React Flow 渲染它，画布副本由 App.tsx 的
 *     store.subscribe 防抖（800ms）反向同步；
 *   · canvasStore.canvases[*].nodes：持久化副本，重启后由 App.tsx:154 setNodes 载入
 *     flowStore 的正是这一份（flowStore 自身不持久化，重启后它是空的）。
 *
 * 为什么画布副本要清**所有**含该 nodeId 的画布，而不是只清 canvasId 那一张：判定谓词按 nodeId
 * 判定"该节点已无 queued||running 任务"，那时**任何**载体上的 `queued:true` 都是陈旧的。若只清
 * 一张（job.canvasId 那一张或"活动画布"那一张），复制画布场景下另一张副本会**永远**留在 true：
 * canvasStore.duplicateCanvas 保留 node.id，两张画布可以各有该 nodeId 的活动任务；A 的任务先结束
 * （此时 B 仍 active，谓词正确地不清），B 的任务结束时只清 B 那一张，A 副本的 true 就再也没有
 * 任何路径去清 —— 而它正是落盘、重启后由 App.tsx:154 setNodes 载回 flowStore 的那一份，于是
 * REQ-001 的症状（"排队中"、按钮永久禁用、终态任务不匹配 isRecoverableJob）原样复现。
 * 反过来"多清一份"没有副作用：谓词已经证明该 nodeId 没有活动任务，任何一份都不该为 true。
 *
 * **本函数是无条件的**：它只回答"怎么清"（清哪些载体），不回答"该不该清"。该不该清由标记
 * 不变式决定（见 clearNodeQueuedMarkerIfNoActiveJob），只有重启恢复在派发前那一次有理由绕过它。
 *
 * **短路（先读后写）**：若所有载体上的标记本来就都是 falsy，本次清除在内容上是空操作，
 * 于是**在做任何写入之前**直接返回。这不只是省两次写入：flowStore.updateNodeData 与
 * canvasStore.setState 都是无条件换新身份（nodes / canvases 数组与节点对象都换新引用），
 * 哪怕数据内容一模一样，也会让 App.tsx:170 的 store.subscribe 命中 → 800ms 防抖 →
 * updateCanvasData → persist → tauriStorage 落盘 app-data.json；也就是"清一个本来就 false 的
 * 标记"会凭空产生**每个任务一次**的整画布持久化写入。判据取的是"这一份是不是 falsy"，所以它只
 * 跳过空操作，绝不会漏掉一份**确实为 true** 的标记（漏掉就是 REQ-001 的永久锁）。
 * 读走本文件顶部的静态 import：判据必须在任何写入之前同步取到。
 */
function clearNodeQueuedMarker(nodeId: string) {
  const flowNode = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  const flowDirty = Boolean((flowNode?.data as ImageGeneratorNodeData | undefined)?.queued);

  const { canvases } = useCanvasStore.getState();
  const dirtyCanvasIds = new Set(
    canvases
      .filter((c) =>
        c.nodes.some(
          (n) => n.id === nodeId && Boolean((n.data as ImageGeneratorNodeData | undefined)?.queued)
        )
      )
      .map((c) => c.id)
  );

  // 所有载体都已经是 falsy（或根本没有该节点）→ 没有可清除的内容，不产生任何写入。
  if (!flowDirty && dirtyCanvasIds.size === 0) return;

  if (flowDirty) {
    useFlowStore.getState().updateNodeData<ImageGeneratorNodeData>(nodeId, { queued: false });
  }

  // 只在确实有画布副本需要清时才写 canvasStore：canvases.map 会换掉数组身份，而 persist 在每个
  // setState 上都会落一次 key（即便内容没变）—— "flowStore 脏、画布副本已是 false"是常见情形，
  // 不能让它白白产生一次画布持久化写入。一次 setState 处理所有命中的画布，避免逐张写。
  if (dirtyCanvasIds.size > 0) {
    useCanvasStore.setState({
      canvases: canvases.map((c) =>
        dirtyCanvasIds.has(c.id)
          ? {
              ...c,
              nodes: c.nodes.map((n) =>
                n.id === nodeId ? { ...n, data: { ...n.data, queued: false } } : n
              ),
            }
          : c
      ),
    });
  }
}

/**
 * #### 标记不变式（queued marker invariant）
 *
 * 不变式是**单向**的，只有这一个方向成立：
 *
 *   `queued:true`  ⟹  该节点至少有一个 `queued || running` 任务
 *
 * **反向不成立，而且是有意如此**（曾经的版本在这里写"当且仅当"/iff，那是过度声称，已改正）：
 * 执行器在任务**开始**的那一刻就写 `queued:false`（imageGenerationExecution.ts:265-267：
 * `status: "loading", queued: false`），于是整个运行期里"该节点有 active 任务"与"标记为 true"
 * 是**分离**的。在同一次真实批次（n=4 / concurrency=1）里抽样，**至少**观察到以下三种
 * (marker|status) 组合：{undefined|idle, false|loading, false|success}
 * —— 例如 `false|loading`：任务正在跑，标记却是 false。
 * ⚠ 这个列举**不是穷举**（曾经的版本写成"实测…组合集合 ="，把抽样当成了全集）：`true|idle`
 * ——刚入队、`status` 仍是 idle、正等并发额度——同样会出现，它正是下面 a) 那条常规置位路径
 * （useImageGeneratorExecution.ts:138-142：`queued: true, status: "idle"`）写出来的。漏掉它只是
 * 列举不全，**不影响结论**：单是 `false|loading` 就足以否证"有 active 任务 ⇒ 标记为 true"。所以
 * "有 active 任务 ⇒ 标记为 true" 不成立，这不是缺陷而是设计：标记的语义是"**排队等待中**"
 * （UI 显示"排队中…"、按钮禁用），不是"该节点有任务"，任务一旦开始就由 `status: loading`
 * 接管 UI。因此下面所有清除路径的判据只能是"**有没有** active 任务"（该清时清），
 * 而不能反过来拿"有 active 任务"去**要求**标记为 true。
 *
 * 注意不变式里说的是**节点**而不是"(canvasId + nodeId) 作用域"，因为标记只有一份载体语义：
 * flowStore 的当前节点（两份画布副本共享同一个 nodeId 命名空间，duplicateCanvas 保留 node.id）。
 * "作用域按 (canvasId, nodeId) 判定"是**入队守卫**的口径（两个画布上的同名节点是各自独立的
 * 入队目标，见 guardScopeKey），那与标记的读写口径是两件事，不要混用：
 *   · 守卫（`hasActiveJobForNode` / `batchChains` key）按 (canvasId, nodeId) —— 决定"这次点击
 *     能不能入队"；
 *   · 标记的复核（`clearNodeQueuedMarkerIfNoActiveJob`）与清除落点（`clearNodeQueuedMarker`）
 *     都按 nodeId —— 决定"现在能不能清标记、清哪些载体"。这两处必须永远一致：谓词按更窄的
 *     口径判定、清除却落在更宽的落点上，就会抹掉另一张画布上那份合法标记（F-R3-1）。
 *
 *   · **置位不止一处**（诚实记录：曾经的版本在这里写"置位只有一处"，那否认了一条真实存在的路径）：
 *       a) hook 在 `enqueue` 返回非空（= 本次点击真的入队了）之后写 `queued:true`
 *          （useImageGeneratorExecution.ts:138-142）——**常规**置位路径；
 *       b) flowStore 的**撤销/重做快照**会把 `queued:true` 整数组写回（flowStore.ts:723
 *          createLightweightSnapshot 保存整个 nodes 数组 → :751 `set({ nodes: previousState.nodes })`
 *          原样恢复）。快照是在标记为 true 的那一刻拍的，所以"任务收尾清标记 → 用户 Ctrl+Z"
 *          就会复活一个陈旧的 true —— 这正是 F-R4-1；
 *       c) 未来任何"整数组写入 nodes"的路径（导入、粘贴、模板、时间旅行调试……）在原理上都能
 *          写出同样的陈旧 true。
 *     也就是说：`queued` 是**可被外部整体写入**的状态，不能假设"只有 hook 会写它"。因此复位
 *     机制不能建立在"枚举所有写入方"之上 —— 见下面的自愈订阅（第 4 条），它让不变式对**任意**
 *     写入方自动成立。
 *   · 复位一律经过下面两个函数（`clearNodeQueuedMarker` / `clearNodeQueuedMarkerIfNoActiveJob`），
 *     并且只有"该节点确实没有 active 任务"时才允许清：
 *       1) `pump` 的收尾复核（`.finally`，任务离开 active 集合的那一刻，覆盖
 *          success / error / cancelled 全部终态，包括执行器在 IPC 窗口内被 abort 时
 *          既不写 `queued:false` 也不更新状态的那种取消路径）——**这是唯一的"任务级常规复位路径"**
 *          （每个任务收尾必然走一次）；
 *       2) 重启恢复 `recoverPersistedQueuedJobs` 的两次复核（派发前 + 派发后）；
 *       3) `cancel` 的 queued 分支（此刻刚把那个任务置为终态，条件复核必然放行）；
 *       4) **自愈订阅**（本文件末尾 `useFlowStore.subscribe`）：flowStore 的 nodes 每次换身份都
 *          复核一遍"标记为 true 的节点是否真有 queued||running 任务"，没有就纠正回 false。
 *          这一条不针对某个具体写入方，而是覆盖上一条里 (b)(c) 那类**整体写入** —— 撤销/重做、
 *          以及将来任何新的写入方，都不需要再补一条清除路径（详见文件末注释）。
 *   · 两处**不做/做了也没用**的复核，如实记录以免读者以为存在多步机制：
 *       a) `cancel` 的 running 分支不做复核：abort 是异步的，那一刻被取消的任务仍是 running 且
 *          仍在 jobs 里，任何按活动任务判定的复核都会把它自己算作活动任务 → 恒为 no-op
 *          （曾在那里放过一次这样的调用，属可证明的死代码，已删除）。所以"取消一个运行中的任务
 *          后标记会被复位"是**一步依赖**：只由上面第 1 条完成 —— 任务进入终态后 pump 的 `.finally`
 *          复核，那时该任务才真正不在 active 集合里，谓词才会放行。不存在两步机制。
 *          （第 4 条的自愈订阅在这条路径上**不承担**清除职责：它只在 nodes 换身份时才跑，而
 *           `cancel` 本身不写节点；等 pump 的复核写完、nodes 换身份时，标记早已是 false。）
 *       b) `enqueue` 被拒分支的那次复核同样恒为 no-op：能进该分支就说明该 nodeId 已有活动任务，
 *          而谓词看的正是"该 nodeId 有没有活动任务"，两次判定之间没有 await。它作为防御性兜底
 *          保留（注释里已注明它是 no-op），真正阻止那次写入的是 hook 的 `admitted` 守卫。
 *
 * 为什么必须条件化（两个真实缺陷的共同根因）：决定性判断只能来自"队列里还有没有 active 任务"。
 * 无条件清除在两个方向上都出过错：
 *   · 该清没清 → 节点永久"排队中"、`ImageGeneratorNode.canRun` 恒为 false、按钮永久禁用，
 *     重启也无法恢复（终态任务不匹配 isRecoverableJob，而 `queued:true` 会随画布副本落盘、
 *     又被 App.tsx 的 setNodes 载回 flowStore）；
 *   · 不该清却清了 → 抹掉一份**合法**标记（例如复制画布场景下另一张画布上同名节点的任务仍在
 *     queued/running），UI 显示"未排队"而实际有任务在等，用户继续点击白点一次。
 *
 * ⚠ **诚实说明：条件化清除并不能保证"按钮可用 ⟹ 点击一定被接受"**（曾经的版本在这里把
 * "UI 显示未排队、按钮可用、点击被静默丢弃"写成条件化**避免**了的症状，那是不准确的描述——
 * 该症状在本轮修复前**在不暂停的正常路径上同样可达**，见下）。
 * 条件化清除保证的只有一件事，**只保证这一件**：谓词放行时才清，于是**不会**抹掉合法标记
 * （F-R2-2 / F-R3-1 的性质）。它**不保证**反向的"标记为 true 只在有任务时出现"，
 * 因为执行器在任务开始时就把标记写 false（见上方单向不变式）。
 *
 * 于是存在一个**用户可见的窗口**（本轮如实记录，不再声称已避免）：一次点击 `n=4`、并发额度
 * `concurrency=1`、**未暂停**。第 1 张图跑完时执行器已写 `status:"success", queued:false`
 * （imageGenerationExecution.ts:265-267），而该节点**仍有 3 个 queued 任务**。此刻
 * `ImageGeneratorNode.tsx:215` 的 `canRun` 为 true（有 prompt、status 不是 loading、标记不是 true），
 * 按钮可点；点击后 `handleGenerate` 直接进 `enqueue`，被 `(canvasId, nodeId)` 守卫按"该节点仍有
 * active 任务"**正确拒绝**——但 `onClick` 不检查结果、也没有任何提示，所以这次点击**没有任何反馈**。
 * 这不是守卫的错（拒绝本身是对的：那 3 个任务确实还在排队），而是**入口缺少反馈**。
 * 处理方式：`handleGenerate` 在 `admitted === false` 分支给出可见提示
 * （useImageGeneratorExecution.ts，见那里的注释）——**不改 UI 布局、不碰 canRun、不把谓词写成
 * `=== false`**（正确的短路会让该值保持 undefined，`=== false` 会把它误判成"未排队"）。
 *
 * 所以：**新增任何清除路径都必须走这两个函数之一，禁止再引入第三套语义**；能证明"此刻没有
 * active 任务"的路径才用无条件版本，其余一律用条件版本。
 * 反过来说：**新增写入方（尤其是"整数组写入 nodes"那种）不需要新增清除路径** —— 文件末的自愈
 * 订阅会自动把不变式收回来。R1–R4 的教训正是"每次都想靠枚举写入方来补漏"，而补漏永远慢一步。
 *
 * 唯一故意绕开条件复核的是**重启恢复派发前**那一次：被清的是上一个进程留下的陈旧标记，而那批
 * 刚水合的 queued 任务由调度器与执行器重新接管，清掉不会破坏不变式。
 *
 * `clearNodeQueuedMarkerIfNoActiveJob` 是重启恢复所需弱化版本的一般化：
 *
 *   · 重启恢复在派发之后复核标记时，"该节点还有一个 `status==='queued'` 的任务"是**合法状态**
 *     —— 可能正是用户在这几毫秒里新点的一次生成（它已正常入队、正等着并发额度）。无条件清除会
 *     把用户刚点出来的标记抹掉，让 UI 显示"未排队"而实际上有任务排队。执行器启动时也会写
 *     `queued:false`，所以清除是安全的。
 *   · `running` 同样算作"不该清"的理由：执行器在解析窗口内被 abort 时不写 `queued:false`，
 *     此时**不清**是有意的——任务马上会变成 cancelled，`pump` 的收尾复核会再清一次，那次才真正
 *     没有 active 任务；若在任务仍然 active 时清，就等于抹掉一份合法标记，正是上面"不该清却
 *     清了"的那一类。
 */
function clearNodeQueuedMarkerIfNoActiveJob(nodeId: string) {
  const { jobs } = useQueueStore.getState();
  // 本函数是标记的**唯一**复核谓词，所有调用方共用同一份作用域解析（nodeId）：pump 的收尾复核、
  // cancel 的 queued 分支、重启恢复的派发后复核，以及文件末自愈订阅的每一次复核。
  // 因此"作用域是否一致"这个问题永远只有一处答案，不存在两套口径漂移的可能。
  // 判定作用域 = **nodeId**（不看 canvasId），这是与 clearNodeQueuedMarker 的清除落点配对的
  // **同一处作用域解析**（两处必须永远一致；不一致就会重演 F-R3-1：谓词按 (canvasId, nodeId) 判定、
  // 清除却落在 nodeId 上，于是画布 A 上同名节点的任务收尾会抹掉画布 B 上那份**合法**标记，
  // 因为 duplicateCanvas 保留了 node.id）。
  //
  // 方向选择：谓词宁可**保留**标记也不误清。误清的代价是 UI 显示"未排队"而节点确实有任务在等，
  // 用户继续点击只会被守卫静默丢弃；保留的代价有限——执行器启动时会写 queued:false，且每个任务
  // 收尾都会再复核一次，届时该 nodeId 已无活动任务，清除自然发生。
  // （反方向"漏清"由 clearNodeQueuedMarker 负责兜住：一旦谓词放行，它清的是**所有**含该 nodeId
  //   的载体，不会把任何一张画布副本留在 true。）
  // 历史任务（success/error/cancelled）不参与判定。
  const hasActiveJob = jobs.some((job) => job.nodeId === nodeId && isActiveJob(job));
  if (hasActiveJob) return;
  clearNodeQueuedMarker(nodeId);
}

// —— 标记自愈（F-R4-1）——
// 背景：`queued:true` 不是"只有 hook 会写"的状态。flowStore 的撤销/重做快照保存的是**整个
// nodes 数组**（flowStore.ts:723 createLightweightSnapshot → :751 set({nodes: previousState.nodes})），
// 而快照是在节点标记为 true 的那一刻拍下的（用户在"排队中"的整个等待期里做任何可撤销编辑都会
// 拍一张）。于是"任务收尾清标记 → 用户 Ctrl+Z"会把那个陈旧的 `queued:true` **整数组原样写回**
// flowStore。此时队列里已无任何活动任务：pump.finally 早已跑过，重启恢复只认 status==='queued'，
// cancel/reject 的复核又需要活动任务或新的入队 —— **没有任何一条既有路径会再清它**。标记随后被
// App.tsx:170 的防抖写进画布副本、落盘，重启后由 App.tsx:154 setNodes 载回，节点永久显示"排队中"、
// 生成按钮永久禁用（ImageGeneratorNode.tsx:215 canRun=false）。
//
// 轮次教训：R1–R4 四轮修复都在"枚举写入方 + 给每一处补一条清除路径"，而写入方（快照恢复）与
// 读取方（谓词）之间总有新的缝。这里换一个方向：不再枚举写入方，而是**让不变式自己持续成立** ——
// 只要 flowStore 的节点数组一变，就复核一次"标记为 true 的节点是否真的有 queued||running 任务"，
// 没有就把它纠正回 false。撤销/重做只是"任意写入方"中的一个；将来任何新的写入方（导入、粘贴、
// 模板、时间旅行调试……）都会被同一条复核覆盖，不需要再有人记得补一条清除路径。
//
// 复核仍**只**经过 clearNodeQueuedMarkerIfNoActiveJob，不自带第二套谓词：
//   · 下面的遍历只挑**候选**（标记为 true 的节点），"该不该清"始终由那唯一的谓词按 **nodeId** 回答
//     （与 clearNodeQueuedMarker 的清除落点同一处作用域解析，见其注释）；
//   · 因此作用域不会漂移：谓词永远是 nodeId 口径、宁可保留也不误清，两条 F-R3-1/F-R2-2 的既有
//     性质原样保留 —— 该 nodeId 只要还有任何 queued||running 任务（哪怕在另一张画布上、哪怕是
//     用户刚点出来的那一个），复核就早退，不会抹掉一份合法标记。
//
// 为什么订阅 flowStore 就够了，不需要再订阅 canvasStore：
//   · 陈旧标记要变成用户可见的锁，**必须**经过 flowStore —— 撤销/重做写的是它（:751），重启后
//     App.tsx:154 setNodes 载入的也是它。这两条路都在下面的订阅范围内，清除落点又覆盖**所有**含该
//     nodeId 的画布副本（clearNodeQueuedMarker 一次 setState 全清），所以画布副本不会成为漏网的一份；
//   · 真正需要单独考虑的只有"画布副本里存在陈旧 true"这一种情形，而它同样逃不掉：清理它的时机
//     取决于它**怎么进入 flowStore**，而每一条路都已被覆盖 ——
//       1) 防抖回灌（App.tsx:170 updateCanvasData）与切画布时的保存（App.tsx:130）：两者都从
//          flowStore 取值。zustand 的订阅是在 set() 内部**同步**通知的，所以撤销写回的陈旧 true
//          在我们这个订阅里当场就被纠正，800ms 后防抖读到的是已纠正的值 —— 副本拿到 false；
//       2) 上一进程落盘的陈旧 true（例如崩溃时节点还排队、而该任务因 status==='running' 从不落盘，
//          于是重启后队列里没有它的任何记录）：App.tsx:154 setNodes 把它带进 flowStore 的那一刻，
//          订阅按"该 nodeId 有无 queued||running 任务"复核 —— 任务确实不在队列里，标记被纠正。
//          这正是 REQ-001 那把锁的自愈；若任务还在队列里（status==='queued' 会被恢复），断言就是
//          "有活动任务"，标记被保留，等执行器启动时自己写 queued:false。两个方向都正确；
//       3) duplicateCanvas：它复制的是**当时合法**的标记，而被复制的那个 nodeId 的任务仍然活动，
//          按 nodeId 口径依然合法，不该清（清了就是 F-R3-1 的误清）。
//     所以 canvasStore 没有任何一条能**独立**产生陈旧 true 的写入路径：要么源头是 flowStore
//     （已被本订阅覆盖），要么落在 (3) 这类"合法性由 nodeId 口径保证"的复制上。再加一个
//     canvasStore 订阅只会换来"每次画布写入都多扫一遍"的 churn，语义收益为零。
//
// 为什么订阅注册在**模块顶层**（queueStore.ts 的模块体，且放在 useQueueStore 定义之后）：
//   · ES 模块体每个进程只求值一次 → 订阅恰好建立一次，不随组件挂载/卸载增减，也不会随
//     React 重渲染而多出副本（放进 hook/useEffect 就会每挂载一次多一份）；
//   · HMR：本文件不声明 `import.meta.hot.accept`（除本句注释自身外，全仓库再无第二处引用），
//     因此它不是自接受
//     边界；改动它会沿 importer 链上抛（最终整页重载），模块图重建后订阅仍恰好一份。
//     即便将来有人给它加了自接受边界、让模块体被重复求值，重复监听也只会退化为"多扫一遍"：
//     第一遍已把命中集合清空，第二遍的候选集为空、直接短路返回 —— 收敛，不会变成循环；
//   · 放在文件末尾可确保 useQueueStore / clearNodeQueuedMarker 等已完成初始化，订阅回调即便
//     同步触发也不会撞上 const 的暂时性死区（水合与恢复都是异步的，正常也不会同步触发）；
//   · 依赖方向是安全的：queueStore 静态 import flowStore，而 flowStore 不 import queueStore
//     （沿 queueStore 的静态 import 图实测：仓库内传递依赖 22 个文件 + 7 个外部裸模块，
//     其中 0 条回边），所以这里不会构成模块初始化环。
//     ⚠ **口径必须写明**，否则这个数字会像前几轮那样被当成"随手估的"（见下）。同一份代码在
//     不同口径下分别得到（实测，TS AST 遍历，非正则）：
//       · **22** = 上面的口径：不追 `export … from` 再导出、含 `import type`；
//       · **20** = 同上再排除 `src/types/**`（那两个纯类型文件）；
//       · **45** = 改为**追** `export … from` 再导出（barrel 文件会把整棵 prompt 树拉进来）；
//       · **19** = 不追再导出、且**不含** `import type`。
//     （曾写作"21 个仓内文件"，实测**没有任何一种自然口径给出 21**，已改正。）
//     7 个外部裸模块里有 6 个来自静态 import（zustand、zustand/middleware、@xyflow/react、
//     @tauri-apps/api/core、lucide-react、uuid），第 7 个 `@tauri-apps/plugin-store` 是
//     tauriStorage.ts:28 用**动态** `import()` 引入的 —— **只数静态 import 的话是 6 个**。
//     数目本身随代码增长会漂移，真正的结论是**0 条回边**，这一条已独立复核（直接回边 0 条，
//     闭包内任一文件传递可达 queueStore 的也是 0 个）。
//     （曾写作"23 个传递静态依赖"——同样是没数过的估值。）
//
// 写循环防护（**延后，不是丢弃** —— F-R5-2）：
// 复核命中后要走 clearNodeQueuedMarker → flowStore.updateNodeData → 又触发本订阅，所以需要重入
// 保护。曾经的写法是 `if (healingQueuedMarkers) return;` —— 那会**丢掉**一条嵌套通知：
// 若某个 flowStore 订阅者（App.tsx 的防抖回写、或将来任何第三方订阅）在治疗自己的通知里又写了一次
// nodes，并由此**新引入**一个陈旧 true，那条通知被吞掉之后就再也没有第二次身份变化去复核它，
// 陈旧 true 永久存活。同文件 :651-662 已经明确否认了"本函数是唯一写入方"这个前提，所以
// "把嵌套通知丢掉"是不可接受的：它不是"跳过冗余工作"，而是**漏掉一次必需的治疗**。
//
// 正确性确实依赖这个标志（旧注释声称"正确性并不依赖这个标志"，那是错的，已删除）：
//   · 标志只用来把嵌套调用**延后**到当前这一轮的收尾之后（healPending），绝不丢弃；
//   · 收尾时若发现被延后过，就用 `useFlowStore.getState().nodes` 的**最新**状态再跑一轮。
//
// 循环终止论证（诚实版）："每一轮至少少一个 true"**不足以**单独论证收敛 —— 嵌套写入可以在同一轮里
// **新引入** true。可以论证的是这一条：只有在某一轮治疗期间**确实发生过** nodes 换身份的嵌套通知
// （healPending 被置位）时才会再跑一轮，而每一轮都会把该轮观察到的候选全部清掉；多出来的轮次只能
// 来自"在本轮治疗**内部**发生的嵌套写入"，所以
//   · 对"写入次数有限"的写入方（撤销/重做、重启 setNodes、以及任何一次性的整数组写入），
//     轮数有限：这些写入方都已经写完、不会再被通知唤醒；
//   · 能持续供给新轮次的，只有"每收到一次通知就再写一次 nodes"的写入方。**但这里曾经写错了一句**
//     （原文：那种写入方"自身就是无界的"）——反例可复现：一个"只在当前看不到任何 queued===true
//     时才写回一个 true"的写入方，**单独运行只写一次就停**（确实有界），可一旦与治疗函数组合，
//     就成了"治疗清掉 → 它补回 → 治疗再清 → 它再补"的往复：实测（同一个无上限突变体）它补回了
//     **200000 次以上**、整段同步栈烧掉 **≈3.5 秒**仍未收敛，最后由探针哨兵在第 200001 轮截停。
//     （round-5 评审判为"一次 10ms 同步栈里 202 轮"，是同一现象的较小剂量。）
//     所以"写入方有界"并不蕴含"循环有界"，上面那条论证本身给不出终止保证。
//   · 因此不靠论证，靠**硬上限**：MAX_HEAL_PASSES 把整段同步栈里最多能跑的轮数钉死。上限之上的
//     代价是**可能漏掉一次治疗**，实测口径（病态写入方 → 达上限退出）：那一轮结束时该节点的陈旧
//     true 仍在。这不是永久丢失，但也不是无条件自愈：它要等**下一次 nodes 换身份**才会被重新复核
//     —— 任何来源的写入都算（用户编辑、撤销/重做、切画布回灌、重启 setNodes……）。也就是说，
//     如果那个病态写入方是**唯一**还会写 nodes 的东西，它自己的下一次写入就会带来自愈；若它彻底
//     停了、而用户也从不碰画布，那个标记会一直留到下一次写入为止 —— 这正是"用可恢复的延迟，
//     换掉不可恢复的冻结"这个取舍的准确边界，不修饰。
//   · 为什么必须有这个上限（这是本轮的唯一实质修复）：这个循环是**同步**跑的，跑在
//     `set()` → 订阅回调的栈里。一旦它不收敛，UI 线程就被钉死 —— 每一步都在同步栈内，
//     React 连一次渲染都排不上。那比它要修的症状（漏掉一次治疗、节点暂时显示"排队中"）
//     **严格更糟**：漏掉的治疗可自愈，冻结的 UI 不可。所以宁可少治一轮，不可多转一轮。
//     注意这个"无上限的同步循环"是 round 5 新引入的面：round 5 之前的实现根本没有循环
//     （嵌套通知直接 return/丢弃），那时不存在这个挂死面。
//   · 极端情况下（写入方抛异常）finally 会清掉标志与延后标记：栈已在解卷，此时 store 的一致性
//     已无从保证，丢掉一次延后不会比抛出的异常本身更糟。
let healingQueuedMarkers = false;
/** 治疗期间发生过的嵌套通知：置位后由当前这一轮的收尾再跑一轮，**不丢弃**。 */
let healPending = false;

/**
 * 每次进入 `healStaleQueuedMarkers` 最多允许跑的轮数（**同步栈上限**，不是"治疗总数"）。
 *
 * 为什么是这个量级：**正常路径**只跑 1 轮（实测：轮数=1、谓词调用=1、治疗自身引起的身份变化=1；
 * 谓词放行的候选清掉即完事，末尾重扫已为 0 就退出）；**需要第 2 轮**的是"某个第三方订阅者在我们的
 * 写入里又塞进来一个新的陈旧 true"（F-R5-2 要修的那一类，撤销/重做回灌、重启 setNodes 都属此列）。
 * 3–8 已经是"一连串独立的嵌套写入"这种极不寻常的情形。取 8 是留足余量又不至于让 UI 可感：即使每
 * 一轮都命中候选，8 轮也只是同一次同步栈里的 8 次小扫描（实测 1ms 量级）。
 */
const MAX_HEAL_PASSES = 8;

/** 挑出这批节点里标记为 `true` 的**候选** nodeId（判断与清除始终委托给唯一谓词）。 */
function collectQueuedMarkerCandidates(
  nodes: ReturnType<typeof useFlowStore.getState>["nodes"]
): string[] {
  const candidates: string[] = [];
  for (const node of nodes) {
    if ((node.data as ImageGeneratorNodeData | undefined)?.queued !== true) continue;
    // 同一 nodeId 在 nodes 里只出现一次；去重很廉价，但让"每个 nodeId 最多复核一次"成为不依赖
    // 数组结构的性质。
    if (!candidates.includes(node.id)) candidates.push(node.id);
  }
  return candidates;
}

/** 复核这批节点里的 `queued:true`，把没有活动任务的那些纠正回 false。 */
function healStaleQueuedMarkers(nodes: ReturnType<typeof useFlowStore.getState>["nodes"]) {
  // 重入：**延后**，不丢弃（见上方 F-R5-2 说明）。这一行在任何候选扫描与任何写入之前，
  // 所以嵌套调用本身零成本、零副作用。
  if (healingQueuedMarkers) {
    healPending = true;
    return;
  }

  // 短路（F-R3-2 的延续）：候选为空时在**任何写入之前**、也在**置位重入标志之前**返回，因此
  // "标记本来就正确"的收尾（每个任务都会写一次 `queued:false`）不会产生身份变化、subscribe
  // 命中或画布落盘。
  let candidates = collectQueuedMarkerCandidates(nodes);
  if (candidates.length === 0) return;

  healingQueuedMarkers = true;
  // 本段同步栈里已经跑过的轮数（不含"零候选直接返回"的那条早退）。上限见 MAX_HEAL_PASSES。
  let passes = 0;
  try {
    for (;;) {
      passes += 1;
      for (const nodeId of candidates) {
        // 谓词在这里重新读 jobs 做最终判定：该 nodeId 仍有 queued||running 任务时它什么都不做
        // —— 那是**合法**标记（用户刚点出来的那一个，或另一张画布上的同名节点），不该被抹掉。
        clearNodeQueuedMarkerIfNoActiveJob(nodeId);
      }
      // 本轮治疗期间若有嵌套通知被延后，就用**最新**的 nodes 再跑一轮；没有就退出。
      // ⚠ 诚实说明（探针实测，counters 突变体计数）：**正常路径不会在这里退出**——这一行曾被注释
      // 说成正常路径的出口，是错的。正常路径上写 nodes 的就是治疗自己：
      // clearNodeQueuedMarkerIfNoActiveJob → flowStore.updateNodeData → set(nodes)，而 zustand 的
      // 订阅在 set() **内部同步**通知，那一刻 healingQueuedMarkers 恰为 true，于是这次"自写"通知
      // 也把 healPending 置位（实测：治疗函数重入 1 次、healPending 置位 1 次）。
      // 于是正常路径走的是：本行**不** break（healPending 为 true，实测命中 0 次）→ 末尾重扫候选，
      // 已经是 0（刚才那个 true 已被清掉）→ 在下一轮开始前退出。**实测正常路径：轮数 = 1、
      // 谓词调用 = 1、治疗自身引起的身份变化 = 1**（触发那一次 setState 不算在内）：循环体只写一次，
      // 第 2 轮从未开始，F-R3-2 的性质原样保留。
      // 需要**真的多跑一轮**的是 F-R5-2 那一类：某个第三方订阅者在我们的写入里又塞进来一个
      // **新的**陈旧 true —— 那末尾重扫就不是 0，于是第 2 轮开跑并把它清掉。
      // 本行只在"本轮压根没有嵌套写入"时才命中（例如候选全被谓词放行保留、谁都没写 nodes 的情形）。
      if (!healPending) break;
      healPending = false;
      candidates = collectQueuedMarkerCandidates(useFlowStore.getState().nodes);
      // **正常路径的真实出口**：重扫发现已无候选 → 在**下一轮开始之前**、且**不做任何写入**就退出。
      // 正常路径上这里是 0（唯一那个 true 已被本轮清掉）：实测轮数=1、谓词调用=1、身份变化=1，
      // 等价于"只跑了一轮"。只有嵌套写入新塞进来的陈旧 true 才会让它非 0（第 2 轮）。
      if (candidates.length === 0) break;
      // 硬上限：到顶就退出，绝不继续在同一段同步栈里转下去（理由见上方循环终止论证）。
      // ⚠ **位置是有语义的，必须留在零候选重扫之后**（round 7 修正）。上限检查曾放在重扫**之前**，
      // 于是第 8 轮治完、healPending 为真时直接退出，**这一轮的重扫从未发生**：既丢掉了"其实已经
      // 治好"这个事实，也把治好误报成"仍有陈旧标记未复核"。
      // 实测（有界写入方只在看不到 true 时补回一个 true、补 N 次即永久停手；插桩 + 单实例强制；
      // 对照 = 同一份源码把上限块移回重扫之前的前缀突变体）：
      //   · 修正前：N=7 时第 8 轮已把最后一个陈旧 true 清掉（标记 false），却仍发出 1 条
      //     "仍有陈旧标记未复核"的警告 —— **确证的误报**（重扫只发生 7 次，出口是 cap 而非 zero）；
      //   · 修正后：N=7 重扫 8 次、出口是 zero-candidate、**零警告**，标记 false。误报消失。
      //   · **但治愈边界没有移动，这里必须如实写明**（"移动检查点即可让 N=9/N=12 自愈"这个
      //     预设**不成立**，实测反例）：本上限限的是**轮数**，不是重扫次数。把检查点后移只让第 8 轮
      //     的重扫得以发生，**并不会多给一轮** —— 第 8 轮仍是最后一轮。
      //     实测治愈边界（两版**完全相同**）：N ≤ 7 治愈（轮数 = N+1，逐轮 +1）；N ≥ 8 停在上限：
      //     轮数恒为 8、标记停在 true、恰好 1 条警告。N=8 / N=9 / N=12 都**没有**被治好。
      //     能把它们治好的是一份 `MAX_HEAL_PASSES = Infinity` 的突变体：N=9 需 10 轮、N=12 需 13 轮。
      //     所以"N≥8 残留"是**上限本身的代价**（如实记录，不修饰），不是检查点位置造成的；
      //     不调大上限就不会消失。本轮只按既定范围修正位置，**没有**改上限数值。
      // 语序因此是：先把这一轮的账算清（重扫），再判断是否到顶。这样 `candidates.length === 0`
      // 的分支先命中 —— 上面 N=7 的实测（出口 zero-candidate、零警告）走的就是这条分支。
      // ⚠ **但"治好了就绝不报未复核"只在"候选集里只有陈旧标记"这一种形状上成立，不是普适结论**
      // （round 8 独立审查的反例，已核实并采纳）：候选的判定口径是"marker 为 **true**"
      // （collectQueuedMarkerCandidates），**不是**"marker 陈旧"；而谓词有意**保留合法标记**
      // （:931-932）。所以只要场景里再多一个合法标记（例如另一节点真有 queued 任务），重扫就
      // 永远非空、这一行永远不命中，出口必然落到下面的上限拦停 —— **即便陈旧的那一个已经治好**。
      // 因此上限告警不能拿"候选非空"当"陈旧标记仍在"的证明，见下面的只读判据。
      // 上限本身仍然承载终止性（病态写入方每收到通知就补回 true：修正后依旧恰好 8 轮、0–1ms 内
      // 退出并告警 1 条；对照 MAX_HEAL_PASSES=∞ 的同一份源码突变体跑满探针硬闸 401 轮仍未返回）。
      if (passes >= MAX_HEAL_PASSES) {
        // 只记录，**不改任何状态**：已完成的治疗保持有效，仍未治疗的候选不会被吞掉 ——
        // 下一次 nodes 换身份（任何写入方、任何来源）会重新进来复核。UI 线程优先于本轮治完。
        // ⚠ 走到这里时 candidates **非空**，但这**不能**推出"仍有陈旧 queued 标记未复核"
        // （round 8 修正，原文曾是"已核实的事实"）：candidates 的判据只是"marker 为 true"
        // （collectQueuedMarkerCandidates），其中可能**全是**谓词有意保留的**合法**标记
        // （:931-932：该 nodeId 仍有 queued||running 任务）。合法标记单独就能让重扫永远非空、
        // 让出口永远是这里 —— 于是"候选非空"在那种形状下是"本轮未重新收敛"的**同义反复**，
        // 而不是"陈旧标记仍在"的证据（独立审查的 LEGAL+X 反例已核实）。
        // 所以这里**只读地重算一遍**还剩几个"真正可清"的候选，用与谓词**同一个作用域（nodeId）**
        // 判定，不引入第二套口径：marker 在 flowStore 里**仍为 true** 且该 nodeId **没有**
        // queued||running 任务 —— 那才是下一轮谓词必然会清掉、本次却没来得及复核完的那一份。
        // 只影响**是否打印**：下面的 break 无条件执行，终止性绝不依赖这个判据（也不要靠它）。
        const { jobs: jobsAtCap } = useQueueStore.getState();
        const nodesAtCap = useFlowStore.getState().nodes;
        const stillClearable = candidates.filter(
          (nodeId) =>
            nodesAtCap.some(
              (n) => n.id === nodeId && (n.data as ImageGeneratorNodeData | undefined)?.queued === true
            ) && !jobsAtCap.some((job) => job.nodeId === nodeId && isActiveJob(job))
        ).length;
        if (stillClearable > 0) {
          console.warn(
            `[queueStore] 标记自愈达到单次轮数上限 ${MAX_HEAL_PASSES}，已提前退出：仍有 ${stillClearable} 个可清的陈旧 queued 标记` +
              `未复核完（判据：这些 nodeId 在 flowStore 里仍为 true 且当前没有 queued||running 任务），` +
              `将在下一次节点数组变化时自愈。若该警告重复出现，说明存在"每收到一次通知就重写 nodes"的写入方。`
          );
        }
        // 无论是否告警都在此停手：合法的 true 标记本来就不该被这一轮抹掉，也不该让它把同步栈拖长。
        break;
      }
    }
  } finally {
    healingQueuedMarkers = false;
    healPending = false;
  }
}

useFlowStore.subscribe((state, prevState) => {
  // 与 App.tsx:170 同构：只在 nodes 换身份时复核一句。选中态/连线的变化不碰节点数据，直接跳过。
  if (state.nodes === prevState.nodes) return;
  healStaleQueuedMarkers(state.nodes);
});

