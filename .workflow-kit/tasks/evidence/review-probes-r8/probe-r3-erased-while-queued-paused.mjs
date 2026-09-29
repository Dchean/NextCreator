/**
 * 独立审查探针 R3-E（TASK-006 第三轮 / PRIORITY 1 —— 决定性证据，持续可见）
 *
 * 证明：本轮**新增**的 "pump.finally 收尾复核"（queueStore.ts:511）会在该节点确实还有 queued 任务、
 * 且该任务短期不会被派发时，把标记抹成 false，并让生成按钮重新可用（点击被守卫静默丢弃）。
 *
 * 根因：判定作用域 = (job.canvasId ?? null, nodeId)（queueStore.ts:642-648），
 *       但清除落点只认 nodeId（flowStore 分支 :568-573）＋当前活动画布副本（:580-600）。
 *       画布副本保留 node.id（canvasStore.duplicateCanvas），于是"画布 A 上同名节点 X 的任务结束"
 *       会清掉**当前显示**的画布 B 上同名节点 X 的标记，而 B 上的任务仍在 queued 等待。
 *
 * 为什么这次能持续可见：队列处于**暂停**（QueuePanel 的暂停按钮），空出的额度不会被立刻派发，
 * 因此 B 的 job 稳定停在 queued，标记被抹掉的状态会一直显示给用户。
 *
 * 用法：node --experimental-strip-types probe-r3-erased-while-queued-paused.mjs
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
const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { success: false, error: "节点不存在" };
  await new Promise((r) => setTimeout(r, 15));
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
    if (url === "mutant:exec") return { format: "module", source: EXEC_SRC, shortCircuit: true };
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
const { useImageGeneratorExecution } = await import(
  pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href
);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const X = "gen-x";
const Y = "gen-y";
const A = "canvas-a";
const B = "canvas-b";
const mkNode = (id) => ({
  id,
  type: "imageGeneratorNode",
  position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle" },
});
const canvasesWith = (nodesA, nodesB) => [
  { id: A, name: "A", nodes: nodesA, edges: [] },
  { id: B, name: "B（A 的副本）", nodes: nodesB, edges: [] },
];

let handle = null;
function Probe({ data }) {
  const { handleGenerate } = useImageGeneratorExecution(X, data);
  handle = handleGenerate;
  return null;
}

const nodeX = () => useFlowStore.getState().nodes.find((n) => n.id === X);
const isQueued = () => nodeX()?.data?.queued === true;
// ImageGeneratorNode.tsx:215 的真实派生量
const canRun = () => {
  const d = nodeX()?.data ?? {};
  return Boolean(d.prompt) && d.status !== "loading" && !isQueued();
};
const jobs = () => useQueueStore.getState().jobs.map((j) => `${j.nodeId}@${j.canvasId ?? "null"}:${j.status}`);

useCanvasStore.setState({
  canvases: canvasesWith([mkNode(X), mkNode(Y)], [mkNode(X)]),
  activeCanvasId: A,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [mkNode(X), mkNode(Y)], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
renderToStaticMarkup(React.createElement(Probe, { data: useFlowStore.getState().nodes[0].data }));

console.log("步骤 1：画布 A 上让 X 起一个短任务（将触发 finally），让 Y 起一个长任务占住另一个额度");
useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 500 } });
useQueueStore.getState().enqueue({ nodeId: Y, canvasId: A, nodeLabel: "Y", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 5000 } });
await sleep(100);
console.log(`  队列=${jobs().join(", ")}`);

console.log("");
console.log("步骤 2：切到画布 B（复制画布，同名节点 X），在其上点生成 → B 的 job 排队（两个额度都被占）");
useCanvasStore.setState({ activeCanvasId: B });
useFlowStore.setState({ nodes: [mkNode(X)], edges: [] });
renderToStaticMarkup(React.createElement(Probe, { data: useFlowStore.getState().nodes[0].data }));
await handle();
console.log(`  队列=${jobs().join(", ")}`);
console.log(`  B 的 job=${useQueueStore.getState().jobs.find((j) => j.canvasId === B)?.status}`);

console.log("");
console.log("步骤 3：用户点 QueuePanel 的“暂停”（暂停期间空出的额度不会被派发 → B 的 job 稳定停在 queued）");
useQueueStore.getState().togglePaused();
console.log(`  paused=${useQueueStore.getState().paused}`);
console.log(`  此刻标记：flowStore.queued=${JSON.stringify(nodeX()?.data?.queued)}  isQueued=${isQueued()}  canRun=${canRun()}（false=正确显示“排队中”、按钮禁用）`);

console.log("");
console.log("步骤 4：画布 A 的 X 任务自然结束 —— 走本轮新增的 pump.finally 复核 (canvas-a, gen-x)");
await sleep(700);
const bJob = useQueueStore.getState().jobs.find((j) => j.canvasId === B);
console.log(`  队列=${jobs().join(", ")}`);
console.log(`  画布 B 的 job 仍停在 queued=${bJob?.status === "queued"}（status=${bJob?.status}）`);
console.log(`  标记：flowStore.queued=${JSON.stringify(nodeX()?.data?.queued)}  isQueued=${isQueued()}  canRun=${canRun()}`);
console.log(
  `  canvasStore[B].queued=${JSON.stringify(
    useCanvasStore.getState().canvases.find((c) => c.id === B)?.nodes.find((n) => n.id === X)?.data?.queued
  )}（会被 App.tsx:154 setNodes 载回 flowStore，并随画布落盘）`
);

const reproduced = bJob?.status === "queued" && !isQueued();
console.log("");
if (reproduced) {
  console.log('RESULT: 复现（持续可见）——画布 B 上的节点 X 确实有一个 queued 任务在等额度，但标记已被');
  console.log('        画布 A 上同名节点的任务结束时抹成 false：UI 不再显示“排队中”，生成按钮恢复可用。');
} else {
  console.log("RESULT: 未复现。");
}

console.log("");
console.log("步骤 5：该状态下再点一次生成 —— 验证“点击被静默丢弃”（不变式注释声称要避免的症状）");
const before = useQueueStore.getState().jobs.length;
await handle();
const after = useQueueStore.getState().jobs.length;
console.log(`  job 数 ${before} → ${after}（新增 ${after - before}）  点击后 flowStore.queued=${JSON.stringify(nodeX()?.data?.queued)}`);
console.log(`  → 按钮可点（canRun=${canRun()}）但任务未入队：用户看不到任何“排队中”反馈，点击被 REQ-002 守卫静默丢弃。`);
