/**
 * 审查探针（第 5 轮 · 独立审查者 · 第五发）：
 * (I)   嵌套 setState 的通知顺序与是否丢更新（自愈在 flowStore 通知里写 canvasStore / flowStore）。
 * (II)  "标记不变式"注释里的**当且仅当**是否成立（running 任务期间标记是什么）。
 * (III) 由 (II) 推出的用户可见后果：批量任务中前一张已起、其余仍在 queued 时，
 *       节点标记为 false、按钮可点，而点击被 REQ-002 守卫**静默丢弃**（无任务、无反馈）。
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
// 忠实的执行器（与 imageGenerationExecution 的关键写入一致）：启动时写 status=loading + queued:false
const FAITHFUL = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 120));
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
const mk = () => ({ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" } });
const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const status = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.status;
const active = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");
const canRun = () => {
  const d = useFlowStore.getState().nodes.find((n) => n.id === X)?.data;
  return Boolean(d?.prompt) && d?.status !== "loading" && !(d?.queued === true);
};
function reset(batch) {
  const nodes = [mk()];
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes, edges: [], history: [], historyIndex: -1 });
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
}

console.log("========== (I) 嵌套 setState 的通知顺序 / 是否丢更新 ==========");
{
  reset();
  const order = [];
  // 模拟 App.tsx:170 的订阅者（在 queueStore 之后注册，即真实顺序）
  const unsubApp = useFlowStore.subscribe((s, p) => { if (s.nodes !== p.nodes) order.push("app-subscriber"); });
  const unsubQ = useCanvasStore.subscribe(() => order.push("canvas-subscriber"));
  useQueueStore.setState({ jobs: [] });
  useFlowStore.setState({ nodes: [{ ...mk(), data: { ...mk().data, queued: true } }] });
  await sleep(20);
  unsubApp(); unsubQ();
  console.log(`  通知序列=${JSON.stringify(order)}`);
  console.log(`  标记终值 flow=${JSON.stringify(marker())} canvas=${JSON.stringify(useCanvasStore.getState().canvases[0].nodes[0].data.queued)}`);
  console.log(`  队列/画布状态未被破坏：canvases 长度=${useCanvasStore.getState().canvases.length} activeCanvasId=${useCanvasStore.getState().activeCanvasId}`);
  console.log(`  ⇒ ${marker() !== true && useCanvasStore.getState().canvases[0].nodes[0].data.queued !== true ? "嵌套写在订阅回调内落地成功，无警告/无丢失" : "嵌套写异常"}`);
}

console.log("");
console.log("========== (II) 「当且仅当」是否成立：running 期间标记是什么 ==========");
{
  reset();
  const seen = new Set();
  const samples = [];
  const p = (async () => {
    useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 300 } });
    for (let i = 0; i < 40; i++) {
      const st = status();
      const m = marker();
      seen.add(`${JSON.stringify(m)}|${st}`);
      samples.push(`${JSON.stringify(m)}/${st}`);
      await sleep(20);
    }
  })();
  await p;
  console.log(`  (标记|节点status) 采样：${[...seen].join("  ")}`);
  const activeDuringRunning = samples.filter((s) => s.includes("loading")).length;
  console.log(`  status=loading（=有 running 任务在场）的采样数=${activeDuringRunning}`);
  console.log(`  ⇒ running 任务在场时标记=${JSON.stringify(samples.find((s) => s.includes("loading"))?.split("/")[0])} → ${samples.some((s) => s.startsWith("false/loading")) ? "「当且仅当」的**正向**不成立（有活动任务但标记为 false）" : "未观察到"}`);
}

console.log("");
console.log("========== (III) 用户可见后果：批量中剩余任务停在 queued 时，点击被静默丢弃 ==========");
{
  reset();
  let handle = null;
  function Probe() { const { handleGenerate } = useImageGeneratorExecution(X, { ...getDefaultImageGeneratorData(), prompt: "p", n: 2, status: "idle", label: "L" }); handle = handleGenerate; return null; }
  renderToStaticMarkup(React.createElement(Probe));
  useQueueStore.setState({ concurrency: 1, paused: false });
  await handle();   // 真实点击：n=2 → 一次点击入队 2 个（整批），并写 queued:true
  console.log(`  点击后：jobs=${useQueueStore.getState().jobs.map((j) => `${j.status}${j.batchIndex ? "#" + j.batchIndex : ""}`).join(",")} 标记=${JSON.stringify(marker())} 按钮可用=${canRun()}`);
  await sleep(30);
  // 用户在第一批跑动期间按下面板的"暂停"（真实存在的能力）→ 剩余批次稳定停在 queued
  useQueueStore.getState().togglePaused();
  await sleep(400); // 让第 1 张跑完
  const st = status();
  console.log(`  第 1 张跑完、暂停生效后：jobs=${useQueueStore.getState().jobs.map((j) => `${j.status}${j.batchIndex ? "#" + j.batchIndex : ""}`).join(",")} 标记=${JSON.stringify(marker())} 节点status=${JSON.stringify(st)} 按钮可用=${canRun()}`);
  const activeBefore = active().length;
  const total = useQueueStore.getState().jobs.length;
  await handle();   // 用户看到按钮可用 → 再点一次
  console.log(`  再点一次后：任务总数 ${total} → ${useQueueStore.getState().jobs.length}（新增 ${useQueueStore.getState().jobs.length - total}）活动任务=${activeBefore} → ${active().length}`);
  console.log(`  点击后标记=${JSON.stringify(marker())} 按钮可用=${canRun()}`);
  const silent = useQueueStore.getState().jobs.length === total;
  console.log(`  ⇒ ${silent ? "点击被守卫静默丢弃：没有任何新任务、没有\"排队中\"反馈、没有提示（用户可见的无效点击）" : "点击产生了新任务（未丢弃）"}`);
  console.log(`     （此时队列里仍有 ${useQueueStore.getState().jobs.filter((j) => j.status === "queued").length} 个该节点的 queued 任务在等待，标记却为 ${JSON.stringify(marker())}）`);
}
