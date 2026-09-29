import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriStorage } from "@/utils/tauriStorage";
import { executeImageGeneration } from "@/services/imageGenerationExecution";
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
// **该作用域确实没有 queued||running 任务时**才清，见文件末的标记不变式：拒绝往往正是因为同一次
// 连点里被放行的那一击刚写下合法标记，无条件清会把它抹掉（反过来，调用方先写了标记而没有执行
// 路径去清，节点就会被永久锁成"排队中"，所以才必须有这次复核）。
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
    clearNodeQueuedMarker(job.nodeId, job.canvasId);
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
      // 再次出现。只在"该作用域没有仍在排队等待的任务"时清：这样既不会抹掉用户在这个
      // 时间窗内新点的一次生成（它会产生一个新的 queued 任务），也不会干扰正在运行的任务
      // （执行器启动时本就写 queued:false，标记语义与它一致）。
      for (const job of recovered) {
        clearNodeQueuedMarkerIfNoActiveJob(job.nodeId, job.canvasId);
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
          // queued 标记，所以这里必须复核标记，否则调用方（或任何第三方）一旦先写了
          // queued:true 又没有别的执行路径去清，节点就被永久锁成"排队中"（按钮禁用，重启也无效，
          // 因为队列里没有可供 REQ-001 恢复逻辑处置的 queued 任务）。
          //
          // 但复核必须是**条件**的（clearNodeQueuedMarkerIfNoActiveJob，而非无条件清除），
          // 否则会破坏标记不变式：清除是异步落地的（clearNodeQueuedMarker 走动态 import），
          // 在"快速连点"里第 2 次点击被拒时，第 1 次点击的 queued:true 往往刚写下、而它的任务
          // 正合法地停在 queued（并发额度被别人占着），这次异步清除会迟到地把它抹掉 → UI 显示
          // "未排队"、按钮可用，可节点确实有任务在等待，用户继续点击只会被静默丢弃。
          // 条件复核同时保住两件事：没有活动任务时照样复位（防永久锁），有活动任务时保持原状
          // （让"被拒绝的点击在 UI 上无副作用"真正成立——服务端状态与标记语义一致：
          // queued === "本节点确实有活动任务"）。
          clearNodeQueuedMarkerIfNoActiveJob(job.nodeId, job.canvasId ?? null);
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
          // 同步取消同节点的排队状态（两份副本都清，理由见 clearNodeQueuedMarker）。
          // 这里可以无条件清：标记不变式是"该作用域有 queued||running 任务 ⇒ 标记为 true"，
          // 而刚刚置为 cancelled 的正是该作用域仅剩的那个（重复入队守卫保证同作用域至多一个
          // active 任务），所以此刻没有活动任务需要保护标记。
          clearNodeQueuedMarker(job.nodeId, job.canvasId);
        } else if (job.status === "running") {
          // 中断执行器：结果会被丢弃，节点恢复 idle。
          abortControllers.get(id)?.abort();
          // 但"只 abort"不足以复位节点：真实执行器（imageGenerationExecution.ts）在
          // resolveConnectedInputs 的 IPC 窗口内命中 signal.aborted 时**直接 return {cancelled:true}**，
          // 走不到它唯一的启动前写 queued:false（该文件里三处 queued 写全部在 aborted 判定之后），
          // 于是 hook 写下的 queued:true 无人清除 → 节点永久"排队中"、按钮永久禁用，
          // 重启也无效（cancelled 是终态、不匹配 isRecoverableJob，而 queued:true 会随画布副本
          // 落盘又被 App.tsx 载回 flowStore）。
          //
          // 因此取消也必须复核标记，且必须是**条件**的：此刻任务还是 running，无条件清就等于
          // 主动破坏标记不变式（该作用域确实有活动任务）。条件复核满足两边：
          //   · 还在解析窗口内取消 → 执行器马上把任务变 cancelled，见 pump 的收尾复核 → 标记被清；
          //   · 标记本来就该在（任务仍在跑）→ 保持不变。
          // pump 的收尾复核是这里的关键前提：执行器命中 aborted 时既不写 queued:false、
          // 也不更新节点状态，只有"任务离开 active 集合"这一刻才能确定该不该清。
          clearNodeQueuedMarkerIfNoActiveJob(job.nodeId, job.canvasId);
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
              // 节点永久卡在"排队中"（对应 queueStore.cancel 的 running 分支注释）。
              // 调用自身是条件清除，所以无条件调用不会误伤：该作用域若还有 queued||running 任务
              // （例如用户在这个时间窗里新点的一次生成），它什么都不做。
              clearNodeQueuedMarkerIfNoActiveJob(next.nodeId, next.canvasId);
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
 * 为什么两份副本都要清：queued 标记有两份载体 ——
 *   · flowStore.nodes：编辑现场，React Flow 渲染它，画布副本由 App.tsx 的
 *     store.subscribe 防抖（800ms）反向同步；
 *   · canvasStore.canvases[*].nodes：持久化副本，重启后由 App.tsx:154 setNodes 载入
 *     flowStore 的正是这一份（flowStore 自身不持久化，重启后它是空的）。
 * 清除是幂等的、且只动 queued 一个字段（其余字段与 nodes/edges 都取自**当前**状态，
 * 不是快照），所以"多清一份"没有副作用；而"漏清一份"的代价恰好是 REQ-001 的症状：
 * 重启后节点仍显示"排队中"、ImageGeneratorNode 的 canRun 恒为 false、生成按钮永久禁用。
 * 三条会清除标记的路径（取消 / 重启恢复 / 入队被守卫拒绝，外加 pump 的收尾复核）都无法可靠预判
 * 哪一份会被渲染，因此必须两份都清。
 *
 * **本函数是无条件的**：它只回答"怎么清"（清哪两份载体），不回答"该不该清"。该不该清由标记
 * 不变式决定（见 clearNodeQueuedMarkerIfNoActiveJob），三条路径里只有"排队中被取消"这一条
 * 能证明该作用域已无活动任务，其余一律走条件版本。
 *
 * import 失败静默忽略：重启恢复会在无人值守时调用这里，未处理的 rejection 会形成
 * "崩溃 → 重启 → 再恢复"的循环。
 */
function clearNodeQueuedMarker(nodeId: string, canvasId: string | null) {
  void import("@/stores/flowStore")
    .then(({ useFlowStore }) => {
      if (!useFlowStore.getState().nodes.some((n) => n.id === nodeId)) return;
      useFlowStore.getState().updateNodeData<ImageGeneratorNodeData>(nodeId, { queued: false });
    })
    .catch(() => undefined);

  // canvasId 为 null 表示任务没有画布来源标注（旧数据 / 画布尚未就绪时入队），
  // 这类任务由执行器按"活动画布"解析节点（imageGenerationExecution.ts:92-99 在 !canvasId
  // 时读 flowStore），所以它的标记落点就是**当前活动画布**。不能因为 canvasId 为空就跳过
  // 画布副本：那正是持久化、重启后又被 App.tsx:154 setNodes 载回 flowStore 的那一份，
  // 漏掉它就等于 REQ-001 的症状（"排队中"、按钮永久禁用）原样保留。
  void import("@/stores/canvasStore")
    .then(({ useCanvasStore }) => {
      const targetCanvasId = canvasId ?? useCanvasStore.getState().activeCanvasId;
      if (!targetCanvasId) return;
      const { canvases } = useCanvasStore.getState();
      const canvas = canvases.find((c) => c.id === targetCanvasId);
      if (!canvas?.nodes.some((n) => n.id === nodeId)) return;
      useCanvasStore.setState({
        canvases: canvases.map((c) =>
          c.id === targetCanvasId
            ? {
                ...c,
                nodes: c.nodes.map((n) =>
                  n.id === nodeId ? { ...n, data: { ...n.data, queued: false } } : n
                ),
              }
            : c
        ),
      });
    })
    .catch(() => undefined);
}

/**
 * #### 标记不变式（queued marker invariant）
 *
 * 节点上的 `queued:true` **当且仅当**该作用域 `(canvasId + nodeId)` 至少有一个
 * `queued || running` 任务时成立：
 *
 *   · 置位只有一处 —— hook 在 `enqueue` 返回非空（= 本次点击真的入队了）之后写 `queued:true`；
 *   · 复位一律经过下面两个函数，并且只有"该作用域确实没有 active 任务"时才允许清
 *     （`clearNodeQueuedMarkerIfNoActiveJob`）：
 *       1) `pump` 的收尾复核（`.finally`，任务离开 active 集合的那一刻，覆盖
 *          success / error / cancelled 全部终态，包括执行器在 IPC 窗口内被 abort 时
 *          既不写 `queued:false` 也不更新状态的那种取消路径）；
 *       2) 重启恢复 `recoverPersistedQueuedJobs` 的两次复核；
 *       3) `enqueue` 的重复入队守卫拒绝分支；
 *   · 唯一的**无条件**清除是 `cancel` 的 queued 分支：那一刻刚把该作用域仅剩的 active 任务置为
 *     cancelled，清理是恒真的（重复入队守卫保证同作用域至多一个 active 任务）。
 *
 * 为什么必须条件化（两个真实缺陷的共同根因）：决定性判断只能来自"队列里还有没有 active 任务"，
 * 而清除是**异步**落地的（动态 import 后写 flowStore 与 canvasStore）。无条件清除在两个方向上
 * 都出过错：
 *   · 该清没清 → 节点永久"排队中"、`ImageGeneratorNode.canRun` 恒为 false、按钮永久禁用，
 *     重启也无法恢复（终态任务不匹配 isRecoverableJob，而 `queued:true` 会随画布副本落盘、
 *     又被 App.tsx 的 setNodes 载回 flowStore）；
 *   · 不该清却清了 → UI 显示"未排队"、按钮可用，但节点确实有任务在等待，用户继续点击只会被
 *     静默丢弃。
 * 所以：**新增任何清除路径都必须走这两个函数之一，禁止再引入第三套语义**；能证明"此刻没有
 * active 任务"的路径才用无条件版本，其余一律用条件版本。
 *
 * `clearNodeQueuedMarkerIfNoActiveJob` 是重启恢复所需弱化版本的一般化：
 *
 *   · 重启恢复在派发之后复核标记时，"该节点还有一个 `status==='queued'` 的任务"是**合法状态**
 *     —— 可能正是用户在这几毫秒里新点的一次生成（它已正常入队、正等着并发额度）。无条件清除会
 *     把用户刚点出来的标记抹掉，让 UI 显示"未排队"而实际上有任务排队。执行器启动时也会写
 *     `queued:false`，所以清除是安全的。
 *   · 取消（`cancel` 的 running 分支）与 `pump` 的收尾复核还必须把 `running` 也算作"不该清"的理由：
 *     执行器在解析窗口内被 abort 时不写 `queued:false`，此时**不清**是有意的——任务马上会变成
 *     cancelled，`pump` 的收尾复核会再清一次，那次才真正没有 active 任务；若在这里无条件清，
 *     就等于在任务仍然 active 时抹掉标记，正是上面"不该清却清了"的那一类。
 */
function clearNodeQueuedMarkerIfNoActiveJob(nodeId: string, canvasId: string | null) {
  const { jobs } = useQueueStore.getState();
  // 只看"同一画布同一节点"的活动任务，与 enqueue 的重复入队守卫同一判定口径（canvasId 可能为
  // null，null 与 null 视为同一作用域）；历史任务（success/error/cancelled）不参与判定。
  const hasActiveJob = jobs.some(
    (job) => job.nodeId === nodeId && (job.canvasId ?? null) === canvasId && isActiveJob(job)
  );
  if (hasActiveJob) return;
  clearNodeQueuedMarker(nodeId, canvasId);
}
