/**
 * 独立审查探针 8（TASK-006 / REQ-001）—— 时序判定
 *
 * 目的：精确测量"queueStore 恢复派发"与"App 把画布节点灌进 flowStore"这两件事的先后，
 * 以及各自对节点 data.queued 的影响。这是判断 REQ-001 是否真的修好的关键。
 *
 * 建模的真实代码：
 *   · flowStore **不持久化**（flowStore.ts 无 persist）→ 冷启动 nodes 为空
 *   · queueStore 水合 → onRehydrateStorage → recoverPersistedQueuedJobs()
 *       - 清标记：updateNodeQueuedState(job.nodeId, job.canvasId, false)
 *           flowStore 分支：总是执行（此刻 nodes 为空 → updateNodeData 映射空数组 → 无效果）
 *           canvasStore 分支：canvasId === activeCanvasId 时 **直接 return**（第 433 行）
 *       - waitForCanvasReady：条件为 `_hasHydrated || 全部可解析`
 *           → canvasStore 一旦水合完成就**立即放行**，不等 flowStore 载入节点
 *       - pump() → executeImageGeneration → readNodeFromCanvas 读 **flowStore**（活动画布）
 *   · App.tsx:121-163：activeCanvasId 就绪后（React effect）setNodes(画布节点)
 *
 * 用法：node --experimental-strip-types probe-timeline.mjs [appLoadDelayMs]
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const APP_LOAD_DELAY = Number(process.argv[2] ?? 0);
const T0 = Date.now();
const ts = () => `t+${String(Date.now() - T0).padStart(5)}ms`;

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

// 执行器桩：忠实复刻 readNodeFromCanvas(imageGenerationExecution.ts:92-99) 的可见性判定，
// 并记录"派发发生在 flowStore 是否已有该节点"这一事实。
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec-observe", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec-observe") {
      return {
        format: "module",
        source: `export const executeImageGeneration = async (nodeId, options) => {
                   const { useFlowStore } = await import("@/stores/flowStore");
                   const { useCanvasStore } = await import("@/stores/canvasStore");
                   const { activeCanvasId } = useCanvasStore.getState();
                   const flow = useFlowStore.getState();
                   const inFlow = flow.nodes.some((n) => n.id === nodeId);
                   const inCanvas = Boolean(options?.canvasId && useCanvasStore.getState().canvases
                     .find((c) => c.id === options.canvasId)?.nodes.some((n) => n.id === nodeId));
                   const visible = !options?.canvasId || options.canvasId === activeCanvasId ? inFlow : inCanvas;
                   globalThis.__NC_EVENTS__.push({
                     what: "executor-dispatch", nodeId, inFlow, inCanvas, visible,
                     result: visible ? "运行并清除 queued" : "提前返回「节点不存在」，不写 queued",
                   });
                   if (!visible) return { success: false, error: "节点不存在" };  // 行 183-185：不写 queued
                   useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false }); // 行 265-272
                   return { success: true, cancelled: false };
                 };
                 export const getImageBatchCount = () => 1;`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
globalThis.__NC_EVENTS__ = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANVAS_ID = "canvas-1";
const NODE_ID = "node-1";
const JOB_ID = "job-left-queued";

// 重启前磁盘上的两份记录：
//   队列：1 个 queued 任务（partialize 保留 queued）
//   画布：该节点 data.queued=true（点生成时写下，经 App 的 800ms 防抖同步落盘）
globalThis.__NC_STORE_SEED__["next-creator-canvases"] = JSON.stringify({
  state: {
    canvases: [
      {
        id: CANVAS_ID,
        name: "默认画布",
        createdAt: 1,
        updatedAt: 1,
        edges: [],
        nodes: [
          { id: NODE_ID, type: "imageGeneratorNode", position: { x: 0, y: 0 },
            data: { label: "绘图生成", prompt: "hello", queued: true, n: 1 } },
        ],
      },
    ],
    activeCanvasId: CANVAS_ID,
  },
  version: 0,
});
globalThis.__NC_STORE_SEED__["generation-queue"] = JSON.stringify({
  state: {
    jobs: [
      { id: JOB_ID, nodeId: NODE_ID, canvasId: CANVAS_ID, nodeLabel: "绘图生成", modelLabel: "m",
        promptPreview: "hello", status: "queued", createdAt: 1 },
    ],
    concurrency: 2,
  },
  version: 0,
});

const importRepo = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);
const ev = (what, extra = {}) => globalThis.__NC_EVENTS__.push({ what, ...extra });

// —— 模块求值：canvasStore 先（flowStore.ts:20 依赖它），再 flowStore，再 queueStore ——
const { useCanvasStore } = await importRepo("stores/canvasStore.ts");
const { useFlowStore } = await importRepo("stores/flowStore.ts");
ev("modules-evaluated", { flowNodes: useFlowStore.getState().nodes.length });

// 记录节点 queued 标记的所有变化（flowStore 与 canvasStore 两侧）
useFlowStore.subscribe((s, p) => {
  const before = p.nodes.find((n) => n.id === NODE_ID)?.data?.queued;
  const after = s.nodes.find((n) => n.id === NODE_ID)?.data?.queued;
  if (before !== after) ev("flowStore.queued-changed", { from: before, to: after });
});
useCanvasStore.subscribe((s, p) => {
  const before = p.canvases[0]?.nodes[0]?.data?.queued;
  const after = s.canvases[0]?.nodes[0]?.data?.queued;
  if (before !== after) ev("canvasStore.queued-changed", { from: before, to: after });
});

// —— App.tsx:121-163：activeCanvasId 就绪后把画布节点灌进 flowStore（React effect ≈ 宏任务）——
let appLoadScheduled = false;
const scheduleAppLoad = () => {
  if (appLoadScheduled) return;
  const { activeCanvasId, canvases } = useCanvasStore.getState();
  if (!activeCanvasId || canvases.length === 0) return;
  appLoadScheduled = true;
  setTimeout(() => {
    const canvas = useCanvasStore.getState().getActiveCanvas();
    if (!canvas) return;
    ev("app-setNodes", { nodeCount: canvas.nodes.length, nodeQueued: canvas.nodes[0]?.data?.queued });
    useFlowStore.getState().setNodes(canvas.nodes);
    useFlowStore.getState().setEdges(canvas.edges);
  }, APP_LOAD_DELAY);
};
useCanvasStore.subscribe(scheduleAppLoad);
// 若水合在我注册订阅之前就完成了，补一次
setTimeout(() => {
  if (useCanvasStore.getState()._hasHydrated) scheduleAppLoad();
}, 0);

// —— queueStore 水合 → 恢复 ——
const { useQueueStore } = await importRepo("stores/queueStore.ts");
await sleep(400);
ev("checkpoint-400ms", {
  flowNodes: useFlowStore.getState().nodes.length,
  canvasQueued: useCanvasStore.getState().canvases[0]?.nodes[0]?.data?.queued,
  jobStatus: useQueueStore.getState().jobs.find((j) => j.id === JOB_ID)?.status,
});

await sleep(2500);
// 模拟 App.tsx:167-186 的 800ms 防抖同步（flowStore → canvasStore）
{
  const { nodes, edges } = useFlowStore.getState();
  if (nodes.length > 0) {
    ev("debounced-sync-to-canvas", { nodeQueued: nodes[0]?.data?.queued });
    useCanvasStore.getState().updateCanvasData(nodes, edges);
  }
}
await sleep(200);

const job = useQueueStore.getState().jobs.find((j) => j.id === JOB_ID);
const canvasQueued = useCanvasStore.getState().canvases[0]?.nodes[0]?.data?.queued;
const flowNode = useFlowStore.getState().nodes.find((n) => n.id === NODE_ID);
const flowQueued = flowNode?.data?.queued;
const canRun = flowNode ? Boolean(flowNode.data.prompt) && flowNode.data.status !== "loading" && !(flowQueued === true) : "(节点未加载)";

console.log(`== App 加载画布的延迟 = ${APP_LOAD_DELAY}ms ==`);
console.log("");
console.log("事件时间线：");
for (const e of globalThis.__NC_EVENTS__) {
  const { what, ...rest } = e;
  console.log(`  ${what}: ${JSON.stringify(rest)}`);
}
console.log("");
console.log("最终状态：");
console.log(`  遗留 job status = ${job ? job.status : "(消失)"}${job?.error ? `  error="${job.error}"` : ""}`);
console.log(`  flowStore   节点 data.queued = ${JSON.stringify(flowQueued)}   ← ImageGeneratorNode 读这一份`);
console.log(`  canvasStore 节点 data.queued = ${JSON.stringify(canvasQueued)}   ← 落盘的那一份`);
console.log(`  ImageGeneratorNode.canRun = ${canRun}`);
console.log("");
console.log(
  canRun === false && flowQueued === true
    ? "RESULT: **节点锁死**（显示“排队中”、按钮禁用）→ REQ-001 用户可见症状仍存在"
    : canRun === true
      ? "RESULT: 节点可用 → 这一个顺序下 REQ-001 达标"
      : `RESULT: ${canRun}`
);
