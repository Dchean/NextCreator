/**
 * 审查者探针 P-queued-marker（TASK-003 r1 独立审查用；只读）
 *
 * 攻击点：REQ-004 的验收原文要求"不得因复用而让工作流路径开始写入 runRecords 之外的字段
 * 或改变节点 data 语义"。统一后的执行器在**启动时**会写 `queued:false`
 * （imageGenerationExecution.ts:276-283），而旧的 nodeExecutor 实现从不碰 `queued`。
 *
 * 场景：同一节点 X 上同时存在
 *   (a) 队列里一个**仍在 queued** 的任务（因为额度被别的节点占着），节点上因此有合法的
 *       `queued:true`（由 useImageGeneratorGeneratorExecution 在入队成功后写下）；
 *   (b) 用户又对这个节点跑了工作流（工作流不走 enqueue，因此不受入队守卫阻拦）。
 *
 * 断言：
 *   Q1 基线（改动前的 nodeExecutor）在工作流运行后**保留** queued:true
 *   Q2 候选在工作流运行后把 queued 写成 false（若成立即为"工作流路径开始写入 queued 字段"）
 *   Q3 该 false 造成的可观察后果：ImageGeneratorNode.canRun 从 false 变 true
 *      （即"节点仍在排队，但生成按钮已可点"）
 *
 * 用法：node --experimental-strip-types probe-queued-marker.mjs     （在要测的源码根运行）
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const root = process.cwd();
const SRC = path.join(root, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.__NC_STORE_SEED__ = {};

const STUBS = {
  "@xyflow/react": `export default {};export const ReactFlow=()=>null;export const Background=()=>null;export const Controls=()=>null;
    export const MiniMap=()=>null;export const Panel=()=>null;export const Handle=()=>null;export const useReactFlow=()=>({});
    export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;export const addEdge=(e,es)=>es;
    export const MarkerType={};export const Position={};export const ConnectionLineType={};export const SelectionMode={};
    export const useStore=()=>({});export const getBezierPath=()=>["","",0,0];export const BaseEdge=()=>null;
    export const EdgeLabelRenderer=()=>null;export const useNodes=()=>[];export const useEdges=()=>[];`,
  "@tauri-apps/api/core": `export const invoke=async()=>{throw new Error("stub invoke");};
    export const Channel=class{};export const convertFileSrc=(p)=>p;export default {};`,
  "@tauri-apps/api/event": `export const listen=async()=>()=>{};export const emit=async()=>{};export default {};`,
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}
    async get(k){return (globalThis.__NC_STORE_SEED__||{})[k] ?? null;}
    async set(){}async save(){}async delete(){}async keys(){return [];}}
    export const load=async()=>new Store();export default {load};`,
  "@tauri-apps/plugin-fs": `export const readFile=async()=>new Uint8Array();export const writeFile=async()=>{};export const exists=async()=>false;export const mkdir=async()=>{};export const remove=async()=>{};export const stat=async()=>({});export default {};`,
  "@tauri-apps/plugin-dialog": `export const open=async()=>null;export const save=async()=>null;export const message=async()=>{};export const ask=async()=>false;export const confirm=async()=>false;export default {};`,
  "@tauri-apps/plugin-opener": `export const openUrl=async()=>{};export const openPath=async()=>{};export const revealItemInDir=async()=>{};export default {};`,
};
function withTs(p) {
  if (existsSync(p) && path.extname(p)) return p;
  for (const c of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(c)) return c;
  return p;
}
const imageGenUrl = "mutant:probe-imagegen";
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGeneration") return { url: imageGenUrl, shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === imageGenUrl) {
      const real = JSON.stringify(pathToFileURL(path.join(SRC, "services/imageGeneration/index.ts")).href);
      return {
        format: "module", shortCircuit: true,
        source: `
          import { generateImage as rg, editImage as re } from ${real};
          export * from ${real};
          export const generateImage = async () => ({ imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="] });
          export const editImage = async () => ({ imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="] });
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const limiterPath = path.join(SRC, "services/concurrencyLimiter.ts");
const limiter = existsSync(limiterPath)
  ? await import(pathToFileURL(limiterPath).href)
  : {
      // 改动前的源码树里没有这个模块（REQ-005 是本次新增）。用空实现让同一份探针
      // 也能在 before 树上跑，从而把"行为差异"归因到 nodeExecutor 的复用本身。
      resetGlobalConcurrencyLimiter() {},
      setGlobalConcurrencyLimit() {},
      getGlobalConcurrencyLimit() { return 4; },
      getInFlightCount() { return 0; },
      getWaiterCount() { return 0; },
      tryAcquireGlobalSlot() { return () => {}; },
      async acquireGlobalSlot() { return () => {}; },
      onGlobalSlotReleased() { return () => {}; },
    };
const { WorkflowEngine } = await import(pathToFileURL(path.join(SRC, "services/workflowEngine.ts")).href);

const CANVAS = "qm-canvas";
const X = "qm-node-x";       // 同时：队列里有 queued 任务 + 被跑工作流
const Z = "qm-node-z";       // 占住额度的干扰节点
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function node(id, queued) {
  return { id, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...getDefaultImageGeneratorData(), prompt: `qm ${id}`, model: "gemini-2.5-flash-image", ...(queued ? { queued: true } : {}) } };
}
/** 复刻 ImageGeneratorNode.tsx:215 的 canRun（读 flowStore 的当前节点数据） */
function canRun(id) {
  const d = (useFlowStore.getState().nodes.find((n) => n.id === id) || {}).data || {};
  return Boolean(String(d.prompt || "").trim()) && d.status !== "loading" && d.queued !== true;
}

const nodes = [node(X, true), node(Z, false)];
const MODE = process.argv[2] || "external";

limiter.resetGlobalConcurrencyLimiter();
limiter.setGlobalConcurrencyLimit(1);

// 两种建立"X 有一个合法排队中的任务"的方式：
//   external —— 真实度更高：全局额度（上限 1）被**外部**占着（等价于另一个节点的任务在途，
//               与门禁用例 G 的前提构造相同），队列处于未暂停状态，X 的任务因此合法地留在 queued。
//   paused   —— 确定性更高：用 QueuePanel 的暂停让队列不派发 X。
if (MODE === "external") {
  var heldPermit = limiter.tryAcquireGlobalSlot();
  if (!heldPermit) { console.log(JSON.stringify({ error: "无法建立前提：外部未取得唯一额度" })); process.exit(1); }
  useQueueStore.setState({
    paused: false,
    concurrency: 1,
    jobs: [
      { id: "qm-job-x", nodeId: X, canvasId: CANVAS, nodeLabel: "X", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() },
    ],
  });
  useFlowStore.setState({ nodes, edges: [] });
  useCanvasStore.setState({ activeCanvasId: CANVAS, canvases: [{ id: CANVAS, name: "qm", nodes, edges: [] }] });
  useQueueStore.getState().pump();
  await sleep(60);            // 额度取不到 -> X 的任务留在 queued
} else {
  useQueueStore.setState({
    paused: true,
    concurrency: 4,
    jobs: [
      { id: "qm-job-x", nodeId: X, canvasId: CANVAS, nodeLabel: "X", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() },
      { id: "qm-job-z", nodeId: Z, canvasId: CANVAS, nodeLabel: "Z", modelLabel: "m", promptPreview: "p", status: "running", createdAt: Date.now() + 1 },
    ],
  });
  useFlowStore.setState({ nodes, edges: [] });
  useCanvasStore.setState({ activeCanvasId: CANVAS, canvases: [{ id: CANVAS, name: "qm", nodes, edges: [] }] });
}

const before = {
  queuedFlag: useFlowStore.getState().nodes.find((n) => n.id === X).data.queued ?? null,
  canRun: canRun(X),
  queueJobStatus: useQueueStore.getState().jobs.find((j) => j.id === "qm-job-x")?.status,
};

// 用户对这个节点跑工作流（工作流不经 enqueue，不受入队守卫限制）
const engine = new WorkflowEngine({ maxParallelNodes: 3, skipInputNodes: true });
let ctx;
if (MODE === "external") {
  // 启动工作流：它会以 acquireGlobalSlot 排队（此时额度仍被外部占着）。
  const wfPromise = engine.executeWorkflow([nodes[0]], [], CANVAS);
  await sleep(80);
  // 归还外部额度 → 由于 tryAcquireGlobalSlot 在存在等待者时拒绝（防饿死），
  // 额度交给正在排队的工作流，而 X 的队列任务在整个期间都停在 queued。
  heldPermit();
  ctx = await wfPromise;
} else {
  ctx = await engine.executeWorkflow([nodes[0]], [], CANVAS);
}
await sleep(150);

const after = {
  queuedFlag: useFlowStore.getState().nodes.find((n) => n.id === X).data.queued ?? null,
  canRun: canRun(X),
  nodeStatus: useFlowStore.getState().nodes.find((n) => n.id === X).data.status ?? null,
  queueJobStatus: useQueueStore.getState().jobs.find((j) => j.id === "qm-job-x")?.status,
  engineStatus: ctx.status,
};

console.log(JSON.stringify({
  root,
  mode: MODE,
  before,
  after,
  queueJobStillQueued: after.queueJobStatus === "queued",
  queuedFlagPreserved: after.queuedFlag === true,
  canRunFlippedToTrueWhileQueued: after.queueJobStatus === "queued" && before.canRun === false && after.canRun === true,
}, null, 2));
if (typeof heldPermit === "function") heldPermit();
