/**
 * 独立审查探针 R3-D（TASK-006 第三轮 / PRIORITY 1 —— 决定性证据）
 *
 * 目标：证明本轮新增的 "pump.finally 收尾复核" 会在**该节点确实还有 queued 任务**时把标记抹掉，
 * 且抹掉之后**持续可见**（不是被下发调度瞬间覆盖的短暂窗口）。
 *
 * 根因（源码事实）：
 *   · 判定作用域 = (job.canvasId ?? null, nodeId)，见 queueStore.ts:642-648；
 *   · 清除落点只认 nodeId（flowStore 分支，queueStore.ts:568-573）+ 活动画布副本（:580-600）。
 *   两者口径不同：副本画布保留 node.id（canvasStore.duplicateCanvas），因此"画布 A 上同名节点的任务结束"
 *   会清掉**当前显示的画布 B 上同名节点**的标记；而 B 上的任务可能仍在排队。
 *
 * 决定性构造（不需要额外的槽位抢占技巧，纯真实入口）：
 *   concurrency=1；画布 A 的节点 X 正在运行（长任务，delayMs=500）；用户切到画布 B（复制画布，
 *   同名节点 X）点"生成"→ B 的 job 因额度被占而 queued 等待（此时标记应保持 true = "排队中"）。
 *   A 的任务自然结束 → finally 复核 (A,X) → 该作用域已无活动任务 → 清 nodeId=X →
 *   命中的正是**当前显示的 B 的节点对象**。B 的 job 仍在排队，但标记已成 false。
 *
 * 用法：node --experimental-strip-types probe-r3-marker-erased-while-queued.mjs
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
const A = "canvas-a";
const B = "canvas-b";
// 与 canvasStore.duplicateCanvas 同构：复制画布**原样保留 node.id**
const mkNode = () => ({
  id: X,
  type: "imageGeneratorNode",
  position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle" },
});

let handle = null;
function Probe({ data }) {
  const { handleGenerate } = useImageGeneratorExecution(X, data);
  handle = handleGenerate;
  return null;
}
const renderHook = () => renderToStaticMarkup(React.createElement(Probe, { data: useFlowStore.getState().nodes[0].data }));

const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const jobsOf = () => useQueueStore.getState().jobs.map((j) => `${j.canvasId ?? "null"}:${j.status}`);
const activeOf = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");
// ImageGeneratorNode.tsx:174/215 的真实派生量
const isQueued = () => marker() === true;
const canRun = () =>
  Boolean(useFlowStore.getState().nodes[0].data.prompt) &&
  useFlowStore.getState().nodes[0].data.status !== "loading" &&
  !isQueued();

// —— 场景：concurrency=1，画布 A 的 X 长任务运行中，用户切到画布 B 点生成 ——
useCanvasStore.setState({
  canvases: [
    { id: A, name: "A", nodes: [mkNode()], edges: [] },
    { id: B, name: "B（A 的副本）", nodes: [mkNode()], edges: [] },
  ],
  activeCanvasId: A,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
renderHook();

console.log("步骤 1：画布 A 上对节点 X 点生成（concurrency=1，长任务 delayMs=600）");
useQueueStore.getState().enqueue({
  nodeId: X,
  canvasId: A,
  nodeLabel: "X",
  modelLabel: "m",
  promptPreview: "p",
  dataOverride: { delayMs: 600 },
});
await sleep(90);
console.log(`  队列=${jobsOf().join(", ")}`);

console.log("");
console.log("步骤 2：用户切到画布 B（同名节点 X，duplicateCanvas 保留 node.id），App.tsx:154 setNodes 载入 B 的节点");
useCanvasStore.setState({ activeCanvasId: B });
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
renderHook();

console.log("步骤 3：在画布 B 上点生成 → B 的 job 因额度被 A 占住而**排队等待**");
await handle();
console.log(`  队列=${jobsOf().join(", ")}`);
console.log(`  B 的 job 状态=${useQueueStore.getState().jobs.find((j) => j.canvasId === B)?.status}`);
console.log(`  标记：flowStore.queued=${JSON.stringify(marker())}  isQueued=${isQueued()}  canRun=${canRun()}（false=正确显示"排队中"、按钮禁用）`);

console.log("");
console.log("步骤 4：画布 A 的任务自然结束（走新增的 pump.finally 收尾复核）");
await sleep(700);

const bJob = useQueueStore.getState().jobs.find((j) => j.canvasId === B);
console.log(`  队列=${jobsOf().join(", ")}`);
console.log(`  画布 B 的 job 仍在排队=${bJob?.status === "queued"}（status=${bJob?.status}）`);
console.log(`  标记：flowStore.queued=${JSON.stringify(marker())}  isQueued=${isQueued()}  canRun=${canRun()}`);
console.log(
  `  canvasStore[B].queued=${JSON.stringify(
    useCanvasStore.getState().canvases.find((c) => c.id === B)?.nodes.find((n) => n.id === X)?.data?.queued
  )}（这份会被 App.tsx:154 setNodes 载回 flowStore、并落盘）`
);

console.log("");
if (bJob?.status === "queued" && !isQueued()) {
  console.log('RESULT: 复现（持续可见）——画布 B 上的节点确实有 queued 任务在等额度，但标记已被画布 A 的任务');
  console.log('        结束时抹成 false：UI 不再显示"排队中"、生成按钮恢复可用（canRun=true）。');
  console.log("        此时用户再点生成会被 REQ-002 守卫静默丢弃（同作用域已有活动任务，enqueue 返回空串）。");
} else {
  console.log("RESULT: 未复现。");
}

console.log("");
console.log('步骤 5：验证该状态下"再点一次"确实被静默丢弃（标记语义被破坏的实际代价）');
const before = useQueueStore.getState().jobs.length;
await handle();
const after = useQueueStore.getState().jobs.length;
console.log(`  再点一次：job 数 ${before} → ${after}（新增 ${after - before}）`);
console.log(`  点击后标记：queued=${JSON.stringify(marker())}`);
if (after === before) {
  console.log('  → 用户看不到"排队中"、按钮可点，但点击被静默丢弃：与不变式注释声称要避免的症状同类。');
}
