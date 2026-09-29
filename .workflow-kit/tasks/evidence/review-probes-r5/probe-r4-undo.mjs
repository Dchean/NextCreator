/**
 * 独立审查探针 R4-6：撤销（undo）快照是否会**复活**陈旧 queued:true 并形成永久锁？
 *   路径：生成中（queued:true 已写）→ 用户做一次会 saveToHistory 的画布操作 → 任务收尾清标记
 *        → 用户 Ctrl+Z → 快照把 queued:true 写回 flowStore → 无任何路径再清（队列里只剩终态任务，
 *          REQ-001 的恢复只处理 status==='queued'）→ 重启也带不回来（因为落盘副本已被清成 false，
 *          但 App.tsx:154 setNodes 只在切换画布时执行；用户停留在当前画布时 flowStore 就是真相）。
 * 执行器用 faithful（真实形态）。用法：node --experimental-strip-types probe-r4-undo.mjs
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
  for (const cand of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(cand)) return cand;
  return p;
}
const FAITHFUL = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { success: false, error: "节点不存在" };
  await new Promise((r) => setTimeout(r, 10));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 40));
  useFlowStore.getState().updateNodeData(nodeId, { status: "success", error: undefined });
  return { success: true, cancelled: false };
};
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);
`;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec") return { format: "module", source: FAITHFUL, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createRequire } = await import("node:module");
const requireRepo = createRequire(path.join(REPO, "package.json"));
const React = requireRepo("react");
const { renderToStaticMarkup } = requireRepo("react-dom/server");

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { useImageGeneratorExecution } = await import(pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);

const X = "gen-x";
const A = "canvas-a";
const mkNode = () => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" },
});
const PROBE_DATA = { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" };
let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution(X, PROBE_DATA);
  handle = handleGenerate;
  return null;
}
const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const status = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.status;
const canRun = () => {
  const d = useFlowStore.getState().nodes.find((n) => n.id === X)?.data;
  return Boolean(d?.prompt) && d?.status !== "loading" && !(d?.queued === true);
};
const active = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");

useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
useFlowStore.setState({ nodes: [mkNode()], edges: [], history: [], historyIndex: -1 });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
renderToStaticMarkup(React.createElement(Probe));

// ① 生成一个长任务（faithful：启动后写 status=loading，不写 queued:false 直到启动那一刻）
await handle();
console.log(`① 点击后：标记=${JSON.stringify(marker())} 状态=${JSON.stringify(status())} 活动=${active().length}`);

// ② 用户在任务跑动期间做一次会 saveToHistory 的操作（真实入口：新增节点）
useFlowStore.getState().saveToHistory();
const histLen = useFlowStore.getState().history.length;
const snapHasQueuedTrue = useFlowStore.getState().history.some((h) =>
  (h.nodes || []).some((n) => n.id === X && n.data?.queued === true)
);
console.log(`② 生成中执行一次会存档的操作：history 长度=${histLen}，快照里是否含该节点 queued:true=${snapHasQueuedTrue}`);

// ③ 等任务收尾
await sleep(400);
console.log(`③ 任务收尾后：标记=${JSON.stringify(marker())} 状态=${JSON.stringify(status())} 活动=${active().length} 按钮可用=${canRun()}`);

// ④ 用户按 Ctrl+Z（撤销）
let undone = false;
for (let i = 0; i < 5 && !undone; i++) {
  useFlowStore.getState().undo();
  await sleep(10);
  if (marker() === true) undone = true;
}
console.log(`④ 撤销后：标记=${JSON.stringify(marker())} 状态=${JSON.stringify(status())} 活动=${active().length} 按钮可用=${canRun()}`);

// ⑤ 还有没有路径能救回来？重启恢复只处理 queued 任务；此处队列里只剩终态
const recoverable = useQueueStore.getState().jobs.filter((j) => j.status === "queued").length;
console.log(`⑤ 队列中可恢复（status==='queued'）的任务数=${recoverable} → 若为 0，重启恢复不会处置该标记`);

// ⑥ 再点一次生成能否自愈（用户唯一的出路）
if (marker() === true) {
  console.log(`⑥ 尝试第三次点击生成（按钮${canRun() ? "可用" : "禁用"}）`);
  await handle();
  await sleep(300);
  console.log(`   点击后：标记=${JSON.stringify(marker())} 活动=${active().length} 按钮可用=${canRun()}`);
}
const locked = marker() === true && active().length === 0;
console.log("");
console.log(`RESULT: ${locked ? "永久锁复现（queued:true 被撤销快照复活，且无路径清除）" : "未复现"}`);
