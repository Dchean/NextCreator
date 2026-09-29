/**
 * 审查探针（第 5 轮 · 独立审查者 · 第六发）：REQ-002 守卫的"静默丢弃"是否在**不暂停**的
 * 正常批量场景下也可达（决定该缺口的严重度）。
 * 场景：n=4 一次点击（整批 4 个任务）→ 执行器启动时写 queued:false（HEAD 既有行为）→
 * 该节点仍有 3 个 queued 任务，但标记为 false、节点 status 在两张图之间短暂为 success
 * → 生成按钮在这一窗口内可点 → 点击被守卫拒绝且**没有任何反馈**。
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
// 忠实执行器：启动时在**真实 IPC 窗口之后**才写 status=loading + queued:false（与真实实现同序）
const FAITHFUL = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  await new Promise((r) => setTimeout(r, 25)); // 模拟 resolveConnectedInputs 的 IPC 往返
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 150));
  useFlowStore.getState().updateNodeData(nodeId, { status: "success", error: undefined });
  return { success: true, cancelled: false };
};
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 4), 4);
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
const mk = () => ({ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 4, status: "idle", label: "L" } });
const nd = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data;
const marker = () => nd()?.queued;
const statusOf = () => nd()?.status;
const canRun = () => { const d = nd(); return Boolean(d?.prompt) && d?.status !== "loading" && !(d?.queued === true); };
const queuedForX = () => useQueueStore.getState().jobs.filter((j) => j.nodeId === X && (j.status === "queued" || j.status === "running")).length;

useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
useFlowStore.setState({ nodes: [mk()], edges: [], history: [], historyIndex: -1 });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 }); // 用户可设的最小并发

let handle = null;
function Probe() { const { handleGenerate } = useImageGeneratorExecution(X, { ...getDefaultImageGeneratorData(), prompt: "p", n: 4, status: "idle", label: "L" }); handle = handleGenerate; return null; }
renderToStaticMarkup(React.createElement(Probe));

console.log("========== n=4 一次点击、并发=1、**不暂停**：找\"按钮可点但点击必被丢弃\"的窗口 ==========");
await handle();
console.log(`  点击后：jobs=${useQueueStore.getState().jobs.length} 该节点活动=${queuedForX()} 标记=${JSON.stringify(marker())} status=${JSON.stringify(statusOf())} 按钮可用=${canRun()}`);

let windows = 0;
let clicks = 0;
let dropped = 0;
let samples = 0;
for (let i = 0; i < 260; i++) {
  samples++;
  const cr = canRun();
  const act = queuedForX();
  if (cr && act > 0) {
    windows++;
    // 用户看到按钮可点 → 点一次（真实入口）
    clicks++;
    const before = useQueueStore.getState().jobs.length;
    await handle();
    const after = useQueueStore.getState().jobs.length;
    if (after === before) dropped++;
    if (windows <= 3 || i % 40 === 0) {
      console.log(`  [t=${i * 5}ms] 窗口命中：按钮可用=${cr} 该节点活动任务=${act} 标记=${JSON.stringify(marker())} status=${JSON.stringify(statusOf())} → 点击新增=${after - before}`);
    }
  }
  if (useQueueStore.getState().jobs.every((j) => j.status === "success" || j.status === "error" || j.status === "cancelled")) break;
  await sleep(5);
}
console.log("");
console.log(`  采样=${samples} 次；"按钮可点且该节点仍有活动任务"的窗口命中=${windows} 次；其中点击=${clicks} 次，被静默丢弃=${dropped} 次`);
console.log(`  最终：jobs=${useQueueStore.getState().jobs.map((j) => j.status).join(",")} 标记=${JSON.stringify(marker())} status=${JSON.stringify(statusOf())} 按钮可用=${canRun()}`);
console.log(`  ⇒ ${windows > 0 && dropped > 0 ? `正常（非暂停）批量场景下可达：按钮显示可用，点击被守卫丢弃且无任何反馈（${dropped}/${clicks} 次）` : "该窗口未在正常批量场景下命中"}`);
