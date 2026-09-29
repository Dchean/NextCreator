/**
 * 独立审查探针 R4-7：撤销复活陈旧 queued:true 后，是否经 App.tsx:170 防抖回写画布副本并
 * **跨重启**存活 —— 即是否真的复现 REQ-001 的"永久排队中/按钮禁用"。
 *   ① 生成（faithful 执行器）→ 任务跑动期间存档（saveToHistory 会保存 flowStore.nodes 全量快照）
 *   ② 任务收尾（清标记）→ ③ Ctrl+Z 撤销 → flowStore.queued 复活为 true
 *   ④ 模拟 App.tsx:170 的 800ms 防抖：updateCanvasData(flowStore.nodes, edges) → 画布副本变 true
 *   ⑤ 模拟重启：用画布副本水合 canvasStore + 队列只剩终态任务 → 检查节点是否仍锁死、
 *      以及 REQ-001 的恢复逻辑（只处理 status==='queued'）是否处置它
 * 用法：node --experimental-strip-types probe-r4-undo-restart.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const PHASE = process.env.R4_PHASE || "run"; // run | restart

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
  await new Promise((r) => setTimeout(r, options?.resolveMs ?? 10));
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
const fs = await import("node:fs");
const STATE_FILE = path.join(process.env.TEMP, "review-r4", "undo-restart-state.json");

const X = "gen-x";
const A = "canvas-a";
const mkNode = () => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" },
});
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const PROBE_DATA = { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" };

if (PHASE === "restart") {
  // ===== 重启：用落盘的画布副本水合 canvasStore，队列里只有上一轮的终态任务 =====
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  globalThis.__NC_STORE_SEED__ = {
    "next-creator-canvases": JSON.stringify({
      state: { canvases: saved.canvases, activeCanvasId: A, _hasHydrated: true },
      version: 0,
    }),
    "generation-queue": JSON.stringify({ state: { jobs: saved.jobs, concurrency: 2 }, version: 0 }),
  };
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
  await sleep(500); // 水合 + 恢复 + pump
  const cvs = useCanvasStore.getState().canvases;
  const persisted = cvs.find((c) => c.id === A)?.nodes.find((n) => n.id === X)?.data;
  console.log(`重启后：queue.jobs=${useQueueStore.getState().jobs.map((j) => `${j.nodeId}:${j.status}`).join(",")}`);
  console.log(`  画布副本（落盘那份）queued=${JSON.stringify(persisted?.queued)}`);
  // 模拟 App.tsx:154 setNodes：把活动画布的节点灌进 flowStore
  useFlowStore.setState({ nodes: cvs.find((c) => c.id === A).nodes, edges: [] });
  const d = useFlowStore.getState().nodes.find((n) => n.id === X)?.data;
  const canRun = Boolean(d?.prompt) && d?.status !== "loading" && !(d?.queued === true);
  console.log(`  App.tsx setNodes 之后：flowStore.queued=${JSON.stringify(d?.queued)} 按钮可用(canRun)=${canRun}`);
  const recoverable = useQueueStore.getState().jobs.filter((j) => j.status === "queued").length;
  console.log(`  可恢复（status==='queued'）任务数=${recoverable} → 恢复逻辑${recoverable === 0 ? "不会" : "会"}处置这个标记`);
  console.log("");
  console.log(`RESULT: ${d?.queued === true && !canRun && recoverable === 0 ? "永久锁跨重启存活（REQ-001 症状复现）" : "未复现"}`);
} else {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.__NC_STORE_SEED__ = {};
  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
  const { useImageGeneratorExecution } = await import(pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href);

  let handle = null;
  function Probe() {
    const { handleGenerate } = useImageGeneratorExecution(X, PROBE_DATA);
    handle = handleGenerate;
    return null;
  }
  const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
  const active = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");

  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: [mkNode()], edges: [], history: [], historyIndex: -1 });
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
  renderToStaticMarkup(React.createElement(Probe));

  await handle();
  console.log(`① 点击生成：标记=${JSON.stringify(marker())} 活动=${active().length}`);
  // 用户在这个"排队中"窗口里做了一次可撤销的画布操作（拖节点/加节点都会 saveToHistory）
  useFlowStore.getState().saveToHistory();
  const snapTrue = useFlowStore.getState().history.some((h) => (h.nodes || []).some((n) => n.id === X && n.data?.queued === true));
  console.log(`② 排队窗口内做一次画布操作：history 长度=${useFlowStore.getState().history.length}，快照含 queued:true=${snapTrue}`);

  await sleep(400);
  console.log(`③ 任务收尾：标记=${JSON.stringify(marker())} 活动=${active().length}`);

  useFlowStore.getState().undo();
  await sleep(20);
  console.log(`④ Ctrl+Z 撤销：标记=${JSON.stringify(marker())} 活动=${active().length}`);

  // ⑤ 模拟 App.tsx:170 的 800ms 防抖回写
  const { nodes, edges } = useFlowStore.getState();
  useCanvasStore.getState().updateCanvasData(nodes, edges);
  const persisted = useCanvasStore.getState().canvases.find((c) => c.id === A)?.nodes.find((n) => n.id === X)?.data?.queued;
  console.log(`⑤ 防抖回写画布副本后：canvasStore.queued=${JSON.stringify(persisted)}（这份会落盘并被 App.tsx:154 载回）`);

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ canvases: useCanvasStore.getState().canvases, jobs: useQueueStore.getState().jobs }, null, 0)
  );
  console.log(`（状态已写入 ${STATE_FILE}，供重启阶段使用）`);
}
