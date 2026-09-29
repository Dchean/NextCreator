/**
 * 独立审查探针 R4-8：把"撤销复活陈旧 queued:true"的窗口拉到最宽、门槛降到最低的真实序列：
 *   暂停队列（或并发额度占满）→ 点击生成（job 长时间停在 queued，标记 true）
 *   → 用户在等待期间做一次可撤销的画布编辑（存档快照含 queued:true，窗口=整个等待期）
 *   → 用户在队列面板取消该排队任务（走 cancel 的 queued 分支清标记）
 *   → 用户按 Ctrl+Z 撤销自己的编辑 → 快照把 queued:true 写回 flowStore
 *   → 队列里已无任何活动任务，也没有任何路径再清它；防抖回写画布副本后**跨重启存活**。
 * 执行器 faithful。用法：node --experimental-strip-types probe-r4-undo-cancel.mjs [restart]
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const PHASE = process.argv[2] === "restart" ? "restart" : "run";
const STATE_FILE = path.join(process.env.TEMP, "review-r4", "undo-cancel-state.json");
const X = "gen-x";
const A = "canvas-a";

const STUBS = {
  "@xyflow/react": `export const ReactFlow=()=>null;export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;
    export const addEdge=(e,es)=>es;export const MarkerType={};export const Position={};export const ConnectionLineType={};
    export const SelectionMode={};export const useStore=()=>({});export default {};`,
  "@tauri-apps/api/core": `export const invoke=async()=>{throw new Error("stub invoke");};export const Channel=class{};export const convertFileSrc=(p)=>p;export default {};`,
  "@tauri-apps/api/event": `export const listen=async()=>()=>{};export const emit=async()=>{};export default {};`,
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}
    async get(k){return (globalThis.__NC_STORE_SEED__||{})[k] ?? null;}async set(k,v){(globalThis.__NC_WRITES__=globalThis.__NC_WRITES__||[]).push(k);}async save(){}async delete(){}async keys(){return [];}}
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
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);
const mkNode = () => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" },
});
const canvasSeed = (queued) =>
  JSON.stringify({ state: { canvases: [{ id: A, name: "A", nodes: [{ ...mkNode(), data: { ...mkNode().data, queued } }], edges: [] }], activeCanvasId: A, _hasHydrated: true }, version: 0 });

if (PHASE === "restart") {
  const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  globalThis.__NC_STORE_SEED__ = {
    "next-creator-canvases": JSON.stringify({ state: { canvases: saved.canvases, activeCanvasId: A, _hasHydrated: true }, version: 0 }),
    "generation-queue": JSON.stringify({ state: { jobs: saved.jobs, concurrency: 2 }, version: 0 }),
  };
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
  await sleep(600);
  const cvs = useCanvasStore.getState().canvases;
  const persisted = cvs.find((c) => c.id === A)?.nodes.find((n) => n.id === X)?.data;
  console.log(`重启后：队列=${useQueueStore.getState().jobs.map((j) => `${j.nodeId}:${j.status}`).join(",")}`);
  console.log(`  落盘副本 queued=${JSON.stringify(persisted?.queued)}`);
  useFlowStore.setState({ nodes: cvs.find((c) => c.id === A).nodes, edges: [] });
  const d = useFlowStore.getState().nodes.find((n) => n.id === X)?.data;
  const canRun = Boolean(d?.prompt) && d?.status !== "loading" && !(d?.queued === true);
  const recoverable = useQueueStore.getState().jobs.filter((j) => j.status === "queued").length;
  console.log(`  App.tsx:154 setNodes 之后：queued=${JSON.stringify(d?.queued)} canRun=${canRun} 可恢复任务=${recoverable}`);
  console.log(`RESULT[重启]: ${d?.queued === true && !canRun && recoverable === 0 ? "永久锁跨重启存活（“排队中”+按钮禁用，恢复逻辑不处置）" : "未复现"}`);
} else {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.__NC_STORE_SEED__ = {};
  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
  const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
  const { useImageGeneratorExecution } = await import(pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href);

  const PROBE_DATA = { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" };
  let handle = null;
  function Probe() {
    const { handleGenerate } = useImageGeneratorExecution(X, PROBE_DATA);
    handle = handleGenerate;
    return null;
  }
  const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
  const active = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");
  const canRun = () => {
    const d = useFlowStore.getState().nodes.find((n) => n.id === X)?.data;
    return Boolean(d?.prompt) && d?.status !== "loading" && !(d?.queued === true);
  };

  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: [mkNode()], edges: [], history: [], historyIndex: -1 });
  useQueueStore.setState({ jobs: [], paused: true, concurrency: 1 }); // 暂停：排队窗口 = 无限长
  const React = requireRepo("react");
  const { renderToStaticMarkup } = requireRepo("react-dom/server");
  renderToStaticMarkup(React.createElement(Probe));

  await handle(); // 真 hook：写 queued:true
  console.log(`① 暂停状态下点击生成：标记=${JSON.stringify(marker())} 状态=${JSON.stringify(useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.status)} 队列=${active().map((j) => j.status).join(",")} 按钮可用=${canRun()}`);

  // 用户在"排队中"的整个等待期里编辑画布（真实入口：加一个节点 → addNode 会 saveToHistory）
  useFlowStore.getState().addNode("imageInputNode", { x: 320, y: 0 }, { label: "in" });
  const snapTrue = useFlowStore.getState().history.some((h) => (h.nodes || []).some((n) => n.id === X && n.data?.queued === true));
  console.log(`② 等待期间新增一个节点（可撤销操作）：history=${useFlowStore.getState().history.length} 快照含 queued:true=${snapTrue}`);

  console.log(`②b 取消之前（仅此一句为审查者加）：标记=${JSON.stringify(marker())} 活动任务=${active().length}`);
  // 用户取消这个排队任务（QueuePanel 的真实入口）
  const job = useQueueStore.getState().jobs.find((j) => j.nodeId === X);
  useQueueStore.getState().cancel(job.id);
  await sleep(30);
  console.log(`③ 取消排队任务后：job=${useQueueStore.getState().jobs.find((j) => j.id === job.id).status} 标记=${JSON.stringify(marker())} 按钮可用=${canRun()}`);

  // 用户 Ctrl+Z 撤销刚才的编辑
  useFlowStore.getState().undo();
  await sleep(20);
  console.log(`④ Ctrl+Z 撤销后：标记=${JSON.stringify(marker())} 活动任务=${active().length} 按钮可用=${canRun()}`);

  const { nodes, edges } = useFlowStore.getState();
  useCanvasStore.getState().updateCanvasData(nodes, edges);
  const persisted = useCanvasStore.getState().canvases.find((c) => c.id === A)?.nodes.find((n) => n.id === X)?.data?.queued;
  console.log(`⑤ 800ms 防抖回写画布副本：canvasStore.queued=${JSON.stringify(persisted)}（这份会落盘、并被 App.tsx:154 载回 flowStore）`);

  writeFileSync(STATE_FILE, JSON.stringify({ canvases: useCanvasStore.getState().canvases, jobs: useQueueStore.getState().jobs }));
  const locked = marker() === true && active().length === 0;
  console.log("");
  console.log(`RESULT[运行期]: ${locked ? "锁死（无任何活动任务，标记仍为 true，按钮禁用且无自愈路径）" : "未复现"}`);
}
