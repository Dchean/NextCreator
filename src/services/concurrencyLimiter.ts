/**
 * 全局并发额度（REQ-005 的单一来源）
 *
 * 背景（修复前的缺陷）：两条图片生成路径各自持有互不知情的并发上限 ——
 *   · 队列路径 src/stores/queueStore.ts 的 `concurrency`（默认 2，UI 可设 1..4）
 *   · 工作流路径 src/services/workflowEngine.ts 的 `maxParallelNodes`（默认 3）
 * 二者叠加时最坏情况是 2 + 3 = 5 路同时打同一个 API Key，而任何一处都不知道另一处的存在：
 * 用户把队列并发设成 4、同时跑一个工作流，总并发会变成 7，且没有任何地方能查询或限制它。
 *
 * 本模块提供**唯一**可查询、可设置、可观测的全局并发上限。两条路径都在真正开始一段
 * API 工作之前从这里取得**许可**（permit），工作结束后归还；取不到许可的请求必须等待，
 * 而不是立即发出。因此"同时最多几路"只由这里决定。
 *
 * ⚠ 口径（scope）：本上限约束的是**工作流引擎的节点执行**与**生成队列的任务**这两条路径，
 * 不限图片或文本 —— 工作流里的 LLM 节点与图片节点都要取额度。措辞上它是"全应用在途任务上限"，
 * 不是"图片并发上限"：一个工作流若含 3 个 LLM 节点，它们同样占用额度。
 * 已知**不在**本上限内的调用（不打算在本模块解决，如需收口应另立需求）：
 *   · 手动运行 LLM 节点（useLLMContentExecution → llmService.generateLLMContent）—— 不经队列
 *     也不经工作流引擎，目前只受"该节点自身 status === 'loading'"约束；
 *   · 供应商"测试连接"/模型列表刷新（modelListService.listModels）。
 * 这不是遗漏而是范围：REQ-005 只要求"两条制造并发的路径共同遵守一个上限"。
 *
 * 额度取值的依据：上限设为 `DEFAULT_GLOBAL_CONCURRENCY_LIMIT = 4`，等于 UI 允许用户设置的
 * 最大并发数（QueuePanel 的 1..4）。这样两个目标同时成立：
 *   · UI 不会说谎 —— 用户把队列并发设为 4 时，只要没有别处占用额度，4 路确实能跑满；
 *   · 意外叠加被封顶 —— 修复前不可能出现的"队列 + 工作流"组合上限不再可达（原来是 5 或 7）。
 * 若把上限设得比 4 小，UI 的 4 就变成一句无法兑现的承诺；设得更大则回到"没有背压"的老问题。
 *
 * 不做什么：本模块不打断已经发出的 HTTP 请求（那需要传输层配合，见
 * imageGenerationExecution 的取消说明）。它只保证"同一时刻最多 N 路在途"。
 */

/** 全局在途上限。取 UI 允许的最大并发数，见文件头说明。 */
export const DEFAULT_GLOBAL_CONCURRENCY_LIMIT = 4;
/** 可设置范围：至少 1；上限留出余量，避免误配置把额度调到无意义的大值。 */
const MIN_GLOBAL_CONCURRENCY_LIMIT = 1;
const MAX_GLOBAL_CONCURRENCY_LIMIT = 16;

let limit = DEFAULT_GLOBAL_CONCURRENCY_LIMIT;
/** 已发出、尚未归还的许可数量。 */
let inFlight = 0;
/**
 * 复位代数。每次 resetGlobalConcurrencyLimiter() 自增；许可的归还函数绑定创建时的代数，
 * 代数不匹配即视为**作废**（只标记已归还，不再扣减计数、不再通知）。
 *
 * 为什么需要：复位意味着"忘掉所有在途许可"。但复位之前发出的许可，其归还函数仍被持有
 * （例如上一个用例留下的、尚未收尾的任务）；若它稍后照常扣减，就会把**新一轮**的计数
 * 误减到 0 —— 表现正是"刚拿到的额度凭空消失、被占满的前提不成立"，会让并发上限的判断
 * 出现假绿/假红。产品运行时不调用复位，因此代数恒为 0，本机制对生产行为零影响。
 */
let generation = 0;
/** 正在等待许可的请求。按 FIFO 唤醒，避免后来的大任务把先到的小任务饿死。 */
const waiters: Array<(release: (() => void) | null) => void> = [];
/** 许可归还时的通知者（队列用它重新调度 pump）。 */
const releaseListeners = new Set<() => void>();

export function getGlobalConcurrencyLimit(): number {
  return limit;
}

export function setGlobalConcurrencyLimit(next: number): void {
  const clamped = Math.min(
    Math.max(Math.round(Number.isFinite(next) ? next : DEFAULT_GLOBAL_CONCURRENCY_LIMIT), MIN_GLOBAL_CONCURRENCY_LIMIT),
    MAX_GLOBAL_CONCURRENCY_LIMIT
  );
  limit = clamped;
  // 调大额度后可能立刻能满足等待者，主动唤醒。
  drainWaiters();
  notifyRelease();
}

/** 当前在途（已持有许可）的数量。 */
export function getInFlightCount(): number {
  return inFlight;
}

/** 当前等待许可的请求数（门禁/诊断用）。 */
export function getWaiterCount(): number {
  return waiters.length;
}

export function onGlobalSlotReleased(listener: () => void): () => void {
  releaseListeners.add(listener);
  return () => {
    releaseListeners.delete(listener);
  };
}

function notifyRelease(): void {
  for (const listener of [...releaseListeners]) {
    try {
      listener();
    } catch (error) {
      console.error("[concurrencyLimiter] release listener error:", error);
    }
  }
}

/** 创建一个幂等的归还函数：重复调用只归还一次（防止 finally 与错误分支重复释放把额度放大）。 */
function makeRelease(): () => void {
  let released = false;
  const issuedGeneration = generation;
  return () => {
    if (released) return;
    released = true;
    // 复位之前发出的许可：作废，不扣减新一轮的计数（见 generation 的说明）。
    if (issuedGeneration !== generation) return;
    inFlight = Math.max(0, inFlight - 1);
    drainWaiters();
    notifyRelease();
  };
}

/** 把空闲额度分配给等待者（FIFO）。 */
function drainWaiters(): void {
  while (waiters.length > 0 && inFlight < limit) {
    const resolve = waiters.shift()!;
    inFlight += 1;
    resolve(makeRelease());
  }
}

/**
 * 不等待地尝试取得一个许可。成功返回归还函数，失败返回 null。
 * 队列路径用它决定"这个任务现在能不能真的发出去"：拿不到就让它继续留在 queued。
 *
 * ⚠ 公平性：排队等待者存在时**不插队**。工作流路径用 acquireGlobalSlot 排队，队列路径用本函数
 * 抢占；若允许抢占越过等待者，持续 pump 的队列可能把工作流的等待者无限期饿死。
 * 正常情况下 `waiters.length > 0` 就意味着额度已满（drainWaiters 会在归还瞬间把空出的额度
 * 直接交给等待者），所以这条判断在健康状态下不改变行为，只在竞争时保证公平。
 */
export function tryAcquireGlobalSlot(): (() => void) | null {
  if (waiters.length > 0) return null;
  if (inFlight >= limit) return null;
  inFlight += 1;
  return makeRelease();
}

/**
 * 等待取得一个许可；额度已满时排队，直到有人归还。
 * signal 在等待期间被 abort 时返回 null（调用方据此放弃，且**不会**占用额度）。
 */
export function acquireGlobalSlot(signal?: AbortSignal): Promise<(() => void) | null> {
  if (signal?.aborted) return Promise.resolve(null);
  if (inFlight < limit) {
    inFlight += 1;
    return Promise.resolve(makeRelease());
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      const index = waiters.indexOf(entry);
      if (index >= 0) waiters.splice(index, 1);
      resolve(null);
    };
    const entry = (release: (() => void) | null) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(release);
    };
    waiters.push(entry);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 仅供测试/门禁在用例之间复位；产品代码不应调用。 */
export function resetGlobalConcurrencyLimiter(): void {
  limit = DEFAULT_GLOBAL_CONCURRENCY_LIMIT;
  inFlight = 0;
  // 作废此前发出的所有许可：它们的归还函数在代数变化后不再扣减计数（见 generation 的说明）。
  generation += 1;
  // 等待者一律放行（返回 null = 未取得许可），避免用例之间残留悬挂的 promise。
  while (waiters.length > 0) {
    const resolve = waiters.shift()!;
    resolve(null);
  }
  notifyRelease();
}
