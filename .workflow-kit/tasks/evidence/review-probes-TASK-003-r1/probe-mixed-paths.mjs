/**
 * 审查者探针 P-mixed（TASK-003 r1 独立审查用；只读，不修改任何产品代码）
 *
 * 目的：REQ-005 的验收原话是"存在单一可查询的并发上限，两条路径共同遵守；超限请求被排队"。
 * 门禁用例 G 只**模拟**工作流一侧（自己调 limiter.tryAcquireGlobalSlot），从不运行
 * workflowEngine；本探针把**真实队列**与**真实 workflowEngine**同时跑起来，测：
 *   M1 合并上限：limit=1 时，队列任务与工作流节点叠加的真实在途峰值 <= 1
 *   M2 对照可达：limit=4 时同一场景必须出现 >1 的在途峰值（证明探针能观察到重叠）
 *   M3 活性：两条路径的请求最终都完成（排队而不是丢弃）
 *   M4 无泄漏：跑完后 inFlight=0、waiters=0
 *   M5 方向对称：先起工作流再入队（额度被工作流占着，队列必须留在 queued 而不是发出请求）
 *   M6 工作流等待者不被队列饿死：队列持续有 queued 任务时，工作流的 acquireGlobalSlot
 *      仍然能在额度归还后拿到许可（队列用 tryAcquire 且不插队）
 *
 * 运行：node --experimental-strip-types .workflow-kit/tasks/evidence/review-probes-TASK-003-r1/probe-mixed-paths.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(process.cwd());
const SRC = path.join(root, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.__NC_STORE_SEED__ = {};

const STUBS = {
  "@xyflow/react": `export const ReactFlow=()=>null;export const Background=()=>null;export const Controls=()=>null;
    export const MiniMap=()=>null;export const Panel=()=>null;export const Handle=()=>null;export const useReactFlow=()=>({});
    export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;export const addEdge=(e,es)=>es;
    export const MarkerType={};export const Position={};export const ConnectionLineType={};export const SelectionMode={};
    export const useStore=()=>({});export const getBezierPath=()=>["","",0,0];export const BaseEdge=()=>null;
    export const EdgeLabelRenderer=()=>null;export const useNodes=()=>[];export const useEdges=()=>[];export default {};`,
  "@tauri-apps/api/core": `export const invoke=async()=>{throw new Error("stub invoke");};
    export const Channel=class{};export const convertFileSrc=(p)=>p;export default {};`,
  "@tauri-apps/api/event": `export const listen=async()=>()=>{};export const emit=async()=>{};export default {};`,
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}
    async get(k){return (globalThis.__NC_STORE_SEED__||{})[k] ?? null;}
    async set(){}async save(){}async delete(){}async keys(){return [];}}
    export const load=async()=>new Store();export default {load};`,
  "@tauri-apps/plugin-fs": `export const readFile=async()=>new Uint8Array();export const writeFile=async()=>{};export const exists=async()=>false;export const mkdir=async()=>{};export const remove=async()=>{};export const stat=async()=>({});export default {};`,
  "@tauri-apps/plugin-dialog": `export const open=async()=>null;export const save=async()=>null;export const message=async()=>{};export const ask=async()=>false;export const confirm=async()=>false;export default {};`,
  "@tauri-apps/plugin-opener": `export const openUrl=async()=>{};export const openPath=async()=>{};export const revealItemInDir=async()=>{};export default {};`,
};
function withTs(p) {
  if (existsSync(p) && path.extname(p)) return p;
  for (const c of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(c)) return c;
  return p;
}
const imageGenUrl = "mutant:probe-imagegen";
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGeneration") return { url: imageGenUrl, shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === imageGenUrl) {
      const real = JSON.stringify(pathToFileURL(path.join(SRC, "services/imageGeneration/index.ts")).href);
      return {
        format: "module", shortCircuit: true,
        source: `
          import { generateImage as realGenerateImage, editImage as realEditImage } from ${real};
          export * from ${real};
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          async function call() {
            globalThis.__MX__ = globalThis.__MX__ || { active: 0, max: 0, calls: 0 };
            const s = globalThis.__MX__;
            s.calls += 1; s.active += 1;
            if (s.active > s.max) s.max = s.active;
            try { await sleep(220); return { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="] }; }
            finally { s.active -= 1; }
          }
          export const generateImage = async (...a) => call();
          export const editImage = async (...a) => call();
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const limiter = await import(pathToFileURL(path.join(SRC, "services/concurrencyLimiter.ts")).href);
const { WorkflowEngine } = await import(pathToFileURL(path.join(SRC, "services/workflowEngine.ts")).href);

const CANVAS = "mixed-canvas";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok: Boolean(ok), detail }); console.log(`${ok ? "OK  " : "VIOL"}  ${id}  ${detail}`); };

function mkNode(id) {
  return { id, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...getDefaultImageGeneratorData(), prompt: `mixed ${id}`, model: "gemini-2.5-flash-image" } };
}
function resetStores() {
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 4 });
  useFlowStore.setState({ nodes: [], edges: [] });
  useCanvasStore.setState({ activeCanvasId: CANVAS, canvases: [{ id: CANVAS, name: "mixed", nodes: [], edges: [] }] });
}
function seedJob(id, nodeId) {
  useQueueStore.setState((s) => ({
    jobs: [{ id, nodeId, canvasId: CANVAS, nodeLabel: id, modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() }, ...s.jobs],
  }));
}
const count = (st) => useQueueStore.getState().jobs.filter((j) => j.status === st).length;

async function mixedRun(limit, queueFirst) {
  resetStores();
  limiter.resetGlobalConcurrencyLimiter();
  limiter.setGlobalConcurrencyLimit(limit);
  globalThis.__MX__ = globalThis.__MX__ || { active: 0, max: 0, calls: 0 };
  globalThis.__MX__.active = 0; globalThis.__MX__.max = 0; globalThis.__MX__.calls = 0;

  const wfNodes = [mkNode("mx-wf-1"), mkNode("mx-wf-2")];
  const qNodes = [mkNode("mx-q-1"), mkNode("mx-q-2")];
  const allNodes = [...wfNodes, ...qNodes];
  useFlowStore.setState({ nodes: allNodes, edges: [] });
  useCanvasStore.setState({ activeCanvasId: CANVAS, canvases: [{ id: CANVAS, name: "mixed", nodes: allNodes, edges: [] }] });

  const engine = new WorkflowEngine({ maxParallelNodes: 3, skipInputNodes: true });
  let wfPromise = null;
  const samples = [];
  const sampler = setInterval(() => samples.push({ wf: limiter.getInFlightCount(), q: count("running") }), 15);

  if (queueFirst) {
    seedJob("mx-job-1", "mx-q-1");
    seedJob("mx-job-2", "mx-q-2");
    useQueueStore.getState().pump();
    await sleep(80);
    wfPromise = engine.executeWorkflow(wfNodes, [], CANVAS);
  } else {
    wfPromise = engine.executeWorkflow(wfNodes, [], CANVAS);
    await sleep(80);
    seedJob("mx-job-1", "mx-q-1");
    seedJob("mx-job-2", "mx-q-2");
    useQueueStore.getState().pump();
  }

  const deadline = Date.now() + 15000;
  for (;;) {
    const idle = count("running") === 0 && count("queued") === 0 && limiter.getInFlightCount() === 0;
    if (idle && globalThis.__MX__.active === 0) break;
    if (Date.now() > deadline) break;
    await sleep(40);
  }
  await wfPromise.catch(() => {});
  await sleep(200);
  clearInterval(sampler);

  const peak = globalThis.__MX__.max;
  const out = {
    limit,
    queueFirst,
    peakInFlight: peak,
    calls: globalThis.__MX__.calls,
    queue: { success: count("success"), error: count("error"), cancelled: count("cancelled"), queued: count("queued"), running: count("running") },
    inFlight: limiter.getInFlightCount(),
    waiters: limiter.getWaiterCount(),
    sampleMax: samples.reduce((m, s) => Math.max(m, s.wf), 0),
  };
  resetStores();
  limiter.resetGlobalConcurrencyLimiter();
  return out;
}

// --- M1/M2/M3/M4：队列先起，工作流后起 --------------------------------------
const tight = await mixedRun(1, true);
const wide = await mixedRun(4, true);
const reversed = await mixedRun(1, false);

check("M0-control-overlap", wide.peakInFlight >= 2,
  `对照（limit=4）：真实 provider 在途峰值=${wide.peakInFlight}（期望>=2，证明探针能观察到重叠）`);
check("M1-combined-cap", tight.peakInFlight <= 1,
  `limit=1 时真实队列+真实工作流叠加的在途峰值=${tight.peakInFlight}（必须<=1；对照 limit=4 为 ${wide.peakInFlight}）；` +
  `采样中 limiter.getInFlightCount() 最大=${tight.sampleMax}`);
check("M1b-reversed-order-cap", reversed.peakInFlight <= 1,
  `顺序反转（工作流先起、队列后入队）时峰值=${reversed.peakInFlight}（必须<=1）`);
check("M3-liveness", tight.calls === 4 && tight.queue.queued === 0 && tight.queue.running === 0,
  `limit=1 时四条请求全部执行完成：provider 调用=${tight.calls}（期望4）；队列终态 success=${tight.queue.success} error=${tight.queue.error} cancelled=${tight.queue.cancelled}，残留 queued=${tight.queue.queued} running=${tight.queue.running}`);
check("M4-no-leak", tight.inFlight === 0 && tight.waiters === 0 && wide.inFlight === 0 && reversed.inFlight === 0,
  `跑完后：limit=1(队列先)=inFlight ${tight.inFlight}/waiters ${tight.waiters}；limit=4=inFlight ${wide.inFlight}；顺序反转=inFlight ${reversed.inFlight}/waiters ${reversed.waiters}（均期望0）`);

// --- M5/M6：额度被工作流占着时队列必须留在 queued，且工作流等待者不被饿死 -----
{
  resetStores();
  limiter.resetGlobalConcurrencyLimiter();
  limiter.setGlobalConcurrencyLimit(1);
  const held = limiter.tryAcquireGlobalSlot();   // 模拟"工作流正握着唯一额度"
  seedJob("mx-blocked", "mx-q-1");
  useQueueStore.getState().pump();
  await sleep(200);
  const runningWhileBlocked = count("running");
  const queuedWhileBlocked = count("queued");
  const inFlightWhileBlocked = limiter.getInFlightCount();

  // 反向：队列把额度占满时，工作流的 acquireGlobalSlot 必须排队而不是插队
  // ⚠ 必须先清空队列再复位额度：resetGlobalConcurrencyLimiter() 会 notifyRelease →
  //    onGlobalSlotReleased → pump()，那个还停在 queued 的任务会立刻抢走新额度
  //    （这本身正是"额度归还能唤醒队列"的正向证据），使下面的 tryAcquire 拿到 null。
  held();                              // 显式归还原许可，避免代数作废后被误读
  resetStores();
  limiter.resetGlobalConcurrencyLimiter();
  limiter.setGlobalConcurrencyLimit(1);
  const qRelease = limiter.tryAcquireGlobalSlot();
  let wfGot = null;
  const wfWait = limiter.acquireGlobalSlot().then((r) => { wfGot = r; });
  await sleep(30);
  const preempt = limiter.tryAcquireGlobalSlot();
  const waitersSeen = limiter.getWaiterCount();
  qRelease();
  await sleep(30);
  await wfWait;
  const wfWaitedThenGot = wfGot !== null;
  if (wfGot) wfGot();

  resetStores();
  limiter.resetGlobalConcurrencyLimiter();

  check("M5-queue-parks-when-limit-held", runningWhileBlocked === 0 && queuedWhileBlocked === 1 && inFlightWhileBlocked === 1,
    `额度被外部占满时：队列 running=${runningWhileBlocked}（期望0）、仍 queued=${queuedWhileBlocked}（期望1）、全局在途=${inFlightWhileBlocked}`);
  check("M6-workflow-waiter-not-starved", wfWaitedThenGot && preempt === null && waitersSeen === 1,
    `队列持有唯一额度期间：工作流等待者数=${waitersSeen}；队列的 tryAcquireGlobalSlot()=${preempt === null ? "null（不插队）" : "非 null（插队！）"}；额度归还后工作流拿到许可=${wfWaitedThenGot}`);
}

const violated = results.filter((r) => !r.ok);
console.log("");
console.log(`P-mixed 汇总：${results.length - violated.length}/${results.length} 条断言成立`);
if (violated.length > 0) console.log("未成立的断言：" + violated.map((v) => v.id).join(", "));
process.exitCode = violated.length > 0 ? 1 : 0;
console.log(`EXIT CODE: ${process.exitCode}`);
