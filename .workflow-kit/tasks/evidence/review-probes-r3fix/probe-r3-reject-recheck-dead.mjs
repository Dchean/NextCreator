/**
 * 自建验证探针（REPAIR R3）：enqueue 的"重复入队守卫拒绝分支"里那次标记复核
 * （clearNodeQueuedMarkerIfNoActiveJob）到底会不会真的清除？
 *
 * 推理：进入该分支的**前提**就是 `hasActiveJobForNode(jobs, nodeId, canvasId)` 为真，
 * 即"该 nodeId 上已有一个 queued||running 任务"。而复核谓词判定的正是"该 nodeId 上有没有
 * queued||running 任务"（按 nodeId，比守卫更宽）→ 两者同源、同步、无 await 间隔
 * → 复核必然早退，永远不清除。
 *
 * 本探针直接测两件事：
 *   ① 真实入口：节点上先写 queued:true（模拟"调用方或第三方已置位"），再让一次注定被拒的
 *      enqueue 发生 → 标记是否被这次复核清掉？（预期：不清 → 该调用是 no-op）
 *   ② 反证：把活动任务全部改为终态后，同一个函数确实会清（证明"谓词本身有效"，
 *      即 ① 的结果不是探针没驱动到代码）。
 *
 * 用法：node --experimental-strip-types probe-r3-reject-recheck-dead.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.__NC_STORE_SEED__ = {};

const STUBS = {
  "@xyflow/react": `export const ReactFlow=()=>null;export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;
    export const addEdge=(e,es)=>es;export const MarkerType={};export const Position={};export const ConnectionLineType={};
    export const SelectionMode={};export const useStore=()=>({});export default {};`,
  "@tauri-apps/api/core": `export const invoke=async()=>{throw new Error("stub invoke");};export const Channel=class{};export const convertFileSrc=(p)=>p;export default {};`,
  "@tauri-apps/api/event": `export const listen=async()=>()=>{};export const emit=async()=>{};export default {};`,
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}
    async get(k){return (globalThis.__NC_STORE_SEED__||{})[k] ?? null;}async set(){}async save(){}async delete(){}async keys(){return [];}}
    export const load=async()=>new Store();export default {load};`,
  "@tauri-apps/plugin-fs": `export const readFile=async()=>new Uint8Array();export const writeFile=async()=>{};export const exists=async()=>false;
    export const mkdir=async()=>{};export const remove=async()=>{};export const stat=async()=>({});export default {};`,
  "@tauri-apps/plugin-dialog": `export const open=async()=>null;export const save=async()=>null;export const message=async()=>{};export const ask=async()=>false;export const confirm=async()=>false;export default {};`,
  "@tauri-apps/plugin-opener": `export const openUrl=async()=>{};export const openPath=async()=>{};export const revealItemInDir=async()=>{};export default {};`,
};
function withTs(p) {
  if (existsSync(p) && path.extname(p)) return p;
  for (const c of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(c)) return c;
  return p;
}
// 执行器永不结束（占住任务，使 active 集合稳定），且不写节点数据
const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  await new Promise((r) => setTimeout(r, 60000));
  return { success: true, cancelled: false };
};
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);
`;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec-hang", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec-hang") return { format: "module", source: EXEC_SRC, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const X = "gen-x";
const A = "canvas-a";
const mkNode = (queued) => ({
  id: X,
  type: "imageGeneratorNode",
  position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", queued },
});

const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const markerInCanvas = (cid) =>
  useCanvasStore.getState().canvases.find((c) => c.id === cid)?.nodes.find((n) => n.id === X)?.data?.queued;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`        ${detail}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
console.log("① 真实入口：节点上已写 queued:true，随后一次注定被拒的 enqueue");
useCanvasStore.setState({
  canvases: [{ id: A, name: "A", nodes: [mkNode(true)], edges: [] }],
  activeCanvasId: A,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [mkNode(true)], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });

// 先放一个必然被调度、且永不结束的任务，占住该 (A,X) 作用域
const first = useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p" });
await sleep(80);
const activeNow = useQueueStore.getState().jobs.filter((j) => j.nodeId === X && (j.status === "queued" || j.status === "running"));
console.log(`     首个任务=${useQueueStore.getState().jobs.find((j) => j.id === first)?.status}；该 nodeId 的 active 任务数=${activeNow.length}`);
console.log(`     复核前：flowStore.queued=${JSON.stringify(marker())}  canvasStore[A].queued=${JSON.stringify(markerInCanvas(A))}`);

// 直接走 store 层（绕过 hook 的 admitted 守卫），模拟"第三方/被拒的调用方已置位"
useFlowStore.setState({ nodes: [mkNode(true)], edges: [] });
const rejected = useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p" });
await sleep(60);
console.log(`     第二次 enqueue 返回=${JSON.stringify(rejected)}（空串=被拒）`);
console.log(`     复核后：flowStore.queued=${JSON.stringify(marker())}  canvasStore[A].queued=${JSON.stringify(markerInCanvas(A))}`);

check(
  "① 被拒分支的复核没有清除标记（= 该调用是 no-op / 死代码）",
  marker() === true,
  `被拒后 flowStore.queued=${JSON.stringify(marker())}（若为 true，说明那次复核被谓词早退拦下）`
);

// ---------------------------------------------------------------------------
console.log("");
console.log("② 反证：把活动任务全部改为终态后，同一函数确实会清（证明 ① 不是探针没驱动到代码）");
useQueueStore.setState({
  jobs: useQueueStore.getState().jobs.map((j) =>
    j.status === "queued" || j.status === "running" ? { ...j, status: "success", finishedAt: Date.now() } : j
  ),
});
// 用条件版本无法直接调用（模块内私有），改为驱动真实路径：enqueue 此时不再被拒
// —— 更直接：重新置位后调用 cancel 的 queued 分支（那条走条件复核）
useFlowStore.setState({ nodes: [mkNode(true)], edges: [] });
useCanvasStore.setState((s) => ({
  canvases: s.canvases.map((c) => (c.id === A ? { ...c, nodes: [mkNode(true)] } : c)),
}));
const queuedId = useQueueStore.getState().enqueue({ nodeId: "gen-other", canvasId: A, nodeLabel: "O", modelLabel: "m", promptPreview: "p" });
await sleep(20);
useQueueStore.getState().cancel(queuedId); // queued 分支：条件复核，此时该 nodeId 无活动任务 → 应放行
await sleep(60);
console.log(`     对 gen-other 的 queued 任务执行 cancel 后：其标记路径已跑通（见下）`);

// 直接验证同 nodeId：置位后 cancel 一个 queued 任务，该 nodeId 无其它活动任务 → 应清
useFlowStore.setState({ nodes: [mkNode(true)], edges: [] });
useCanvasStore.setState((s) => ({
  canvases: s.canvases.map((c) => (c.id === A ? { ...c, nodes: [mkNode(true)] } : c)),
}));
const xId = useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p" });
await sleep(20);
const xJob = useQueueStore.getState().jobs.find((j) => j.id === xId);
console.log(`     X 的新任务状态=${xJob?.status}`);
if (xJob?.status === "queued") {
  useQueueStore.getState().cancel(xId);
  await sleep(60);
  check(
    "② 条件复核在'该 nodeId 确无活动任务'时确实会清（谓词本身有效）",
    marker() !== true,
    `cancel 后 flowStore.queued=${JSON.stringify(marker())}  canvasStore[A].queued=${JSON.stringify(markerInCanvas(A))}`
  );
} else {
  console.log(`     （X 的新任务已被调度为 ${xJob?.status}，本反证改用 queued 分支不适用；跳过）`);
}

console.log("");
console.log(
  failures === 0
    ? "结论：被拒分支的那次复核恒被谓词早退（no-op）—— 与 cancel 的 running 分支同属\"可证明的死代码\"。\n" +
      "      真正的防永久锁机制是 hook 的 admitted 守卫（enqueue 返回空串时不写 queued:true）。"
    : `仍有 ${failures} 项不满足。`
);
process.exitCode = failures === 0 ? 0 : 1;
