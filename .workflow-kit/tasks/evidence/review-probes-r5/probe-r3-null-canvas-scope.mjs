/**
 * 独立审查探针 R3-A（TASK-006 第三轮 / PRIORITY 1）：
 * 条件复核的"作用域"与"标记落点"口径不一致 → 抹掉**确有活动任务**的合法标记。
 *
 * 口径差异（源码事实）：
 *   · 判定：clearNodeQueuedMarkerIfNoActiveJob (queueStore.ts:642-651)
 *       匹配 (job.canvasId ?? null) === canvasId —— 把 null 当成一个**与任何画布都不相等**的字面作用域；
 *   · 落点：clearNodeQueuedMarker (queueStore.ts:567-601)
 *       targetCanvasId = canvasId ?? activeCanvasId —— 把 null **解析为当前活动画布**。
 *   于是 canvasId=null 的任务，其判定作用域与它实际居住的节点（活动画布上的同名节点）**不是同一个**。
 *
 * 场景（真实可达）：并发额度未占满（concurrency=4），节点 X 上有两个不同来源标注的任务：
 *   · job-R：canvasId=null（画布尚未水合时入队 / 旧数据 / retry 复制而来），正在 running；
 *   · job-Q：canvasId="c1"（活动画布），正在 queued 等额度。
 * 用户在 QueuePanel 上取消 job-R（或 job-R 自然结束走 pump 的 .finally 复核）：
 *   判定只看 null 作用域 → 认为"该作用域没有活动任务" → 清掉 X 的标记；
 *   而 job-Q 明明还在排队，X 的"排队中"标记本应保留。
 * 结果：UI 显示"未排队"、按钮可用（ImageGeneratorNode.canRun=true），用户继续点击被守卫静默丢弃。
 *
 * 用法：node --experimental-strip-types probe-r3-null-canvas-scope.mjs
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

// 忠实写入序列的执行器：开始时写 loading+queued:false
const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { success: false, error: "节点不存在" };
  await new Promise((r) => setTimeout(r, 30));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await new Promise((r) => setTimeout(r, 40));
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
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const X = "gen-x";
const C1 = "c1";
const nodeData = { ...getDefaultImageGeneratorData(), prompt: "X", n: 1, status: "idle", queued: true };

// 活动画布 c1 上有节点 X（标记 queued:true = "X 有任务在等"）
useCanvasStore.setState({
  canvases: [
    {
      id: C1,
      name: "c1",
      nodes: [{ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: nodeData }],
      edges: [],
    },
  ],
  activeCanvasId: C1,
  _hasHydrated: true,
});
useFlowStore.setState({
  nodes: [{ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: nodeData }],
  edges: [],
});

// 队列：job-R（canvasId=null，running）+ job-Q（canvasId=c1，queued 等额度）；容量 4 → pump 不会再拉 job-Q
useQueueStore.setState({
  paused: false,
  concurrency: 4,
  jobs: [
    { id: "job-R", nodeId: X, canvasId: null, nodeLabel: "X", modelLabel: "m", promptPreview: "x", status: "running", createdAt: 1, startedAt: 1 },
    { id: "job-Q", nodeId: X, canvasId: C1, nodeLabel: "X", modelLabel: "m", promptPreview: "x", status: "queued", createdAt: 2 },
  ],
});

const dataOf = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data ?? {};
const canvasDataOf = () =>
  useCanvasStore.getState().canvases.find((c) => c.id === C1)?.nodes.find((n) => n.id === X)?.data ?? {};
const activeJ = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");
const canRun = (d) => Boolean(d.prompt) && d.status !== "loading" && !(d.queued === true);

console.log("步骤 0（前置事实）");
console.log(
  `  活动任务：${activeJ().map((j) => `${j.id}[${j.status},canvasId=${j.canvasId}]`).join(" ")}  → X 确实有 1 个 queued 任务在等额度`
);
console.log(`  flowStore.queued=${JSON.stringify(dataOf().queued)}  canvasStore.queued=${JSON.stringify(canvasDataOf().queued)}`);
console.log(`  ImageGeneratorNode.canRun=${canRun(dataOf())}（false=显示"排队中"、按钮禁用）`);

console.log("");
console.log("步骤 1：取消正在 running 的 job-R（canvasId=null）——QueuePanel 的取消按钮（真实入口）");
useQueueStore.getState().cancel("job-R");
await sleep(80); // 让 clearNodeQueuedMarker 的两条动态 import 落地

const d = dataOf();
const cd = canvasDataOf();
const stillQueued = activeJ().some((j) => j.nodeId === X && j.canvasId === C1 && j.status === "queued");
console.log(
  `  job-R=${useQueueStore.getState().jobs.find((j) => j.id === "job-R").status}  job-Q=${useQueueStore.getState().jobs.find((j) => j.id === "job-Q").status}`
);
console.log(`  job-Q 仍在排队=${stillQueued}`);
console.log(`  flowStore.queued=${JSON.stringify(d.queued)}  →  canRun=${canRun(d)}（true=按钮已可用）`);
console.log(`  canvasStore.queued=${JSON.stringify(cd.queued)}`);
console.log("");
if (stillQueued && d.queued !== true) {
  console.log('RESULT: 复现——X 仍有 queued 任务，但标记被抹成 false：UI 显示"未排队"、按钮可用，');
  console.log("        用户再点只会被 REQ-002 守卫静默丢弃（排队中反馈消失）。");
  console.log("        根因：判定把 canvasId=null 当作独立作用域，而清除落点把 null 解析为活动画布。");
} else {
  console.log("RESULT: 未复现（标记与活动任务一致）。");
}

// 反证：把 job-Q 的 canvasId 也改成 null（判定口径一致）后不应复现
console.log("");
console.log("步骤 2（反证）：job-R/job-Q 的 canvasId 都为 null（判定口径一致）时不应清除");
useFlowStore.setState({
  nodes: [{ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...nodeData, queued: true } }],
});
useCanvasStore.setState((s) => ({
  canvases: s.canvases.map((c) =>
    c.id === C1 ? { ...c, nodes: c.nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) } : c
  ),
}));
useQueueStore.setState({
  jobs: [
    { id: "job-R2", nodeId: X, canvasId: null, nodeLabel: "X", modelLabel: "m", promptPreview: "x", status: "running", createdAt: 1, startedAt: 1 },
    { id: "job-Q2", nodeId: X, canvasId: null, nodeLabel: "X", modelLabel: "m", promptPreview: "x", status: "queued", createdAt: 2 },
  ],
});
useQueueStore.getState().cancel("job-R2");
await sleep(80);
console.log(`  flowStore.queued=${JSON.stringify(dataOf().queued)}（应为 true：判定看到了同作用域的 queued 任务）`);
