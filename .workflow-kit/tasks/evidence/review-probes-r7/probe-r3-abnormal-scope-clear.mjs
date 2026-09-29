/**
 * 独立审查探针 R3-B（TASK-006 第三轮 / PRIORITY 1）：
 * 新增的 pump.finally 收尾复核（queueStore.ts:502-513）按 **job 自己的来源标注 canvasId** 判定作用域，
 * 但清除的落点只认 nodeId（flowStore 分支）——两者口径不一致，导致
 * "同一 nodeId、不同 canvasId 来源"的两个活动任务互相把对方的合法标记抹掉。
 *
 * 两种真实形态：
 *   【形态 1】null 标注 vs 画布标注：节点 X 上有一个 canvasId=null 的遗留任务（旧数据 / retry 复制）
 *            正在运行；用户在活动画布 c1 上对同一节点点生成（作用域 (c1,X) 不同 → 守卫放行、hook 写
 *            queued:true）。遗留任务结束时 finally 复核 (null,X) → 该作用域已无活动任务 → 清除落点按
 *            nodeId 命中 flowStore 里的 X → 把 c1 那份**仍有活动任务**的合法标记抹成 false。
 *   【形态 2】复制画布（duplicateCanvas 保留 node.id）：画布 A 上的 X 有任务在跑，用户切到画布 B
 *            （同名节点 X）点生成，B 的标记刚写下；A 上的任务结束时复核 (A,X) → 清 nodeId=X →
 *            命中的是**当前显示的 B 的节点对象**，B 那份合法标记被抹掉。
 *
 * 后果：UI 显示"未排队"、ImageGeneratorNode.canRun=true（按钮可用），而该节点确实有活动任务，
 * 用户继续点击只会被 REQ-002 守卫静默丢弃（正是本轮修复要消除的症状类别）。
 *
 * 用法：node --experimental-strip-types probe-r3-abnormal-scope-clear.mjs
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

// 忠实执行器：开始时写 loading+queued:false；完成写 success（不碰 queued）
const EXEC_SRC = `
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
const mkNode = () => ({ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle" } });

let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution(X, useFlowStore.getState().nodes[0].data);
  handle = handleGenerate;
  return null;
}

const activeJ = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");
const canRun = (d) => Boolean(d.prompt) && d.status !== "loading" && !(d.queued === true);
const markerIn = (id) => useFlowStore.getState().nodes.find((n) => n.id === id)?.data?.queued;
const markerInCanvas = (cid) =>
  useCanvasStore.getState().canvases.find((c) => c.id === cid)?.nodes.find((n) => n.id === X)?.data?.queued;

/** 记录"标记 true→false"的确切时刻及其瞬间的队列状态 */
function watchMarkerDrop() {
  const events = [];
  let prev = markerIn(X);
  const unsub = useFlowStore.subscribe((s) => {
    const cur = s.nodes.find((n) => n.id === X)?.data?.queued;
    if (cur !== prev) {
      if (prev === true && cur === false) {
        events.push({
          at: Date.now(),
          active: activeJ().map((j) => `${j.nodeId}/${j.canvasId ?? "null"}:${j.status}`),
          hasActiveOtherScope: activeJ().some((j) => j.nodeId === X),
        });
      }
      prev = cur;
    }
  });
  return { events, unsub };
}

async function caseOne() {
  console.log("【形态 1】canvasId=null 的遗留任务 vs 活动画布 c1 上的排队任务（同一 nodeId）");
  useCanvasStore.setState({
    canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }],
    activeCanvasId: A,
    _hasHydrated: true,
  });
  useFlowStore.setState({ nodes: [mkNode()], edges: [] });
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
  renderToStaticMarkup(React.createElement(Probe));

  // 遗留任务：canvasId=null（旧数据/retry 复制的来源标注），长任务占住唯一额度
  useQueueStore.getState().enqueue({
    nodeId: X,
    canvasId: null,
    nodeLabel: "X",
    modelLabel: "m",
    promptPreview: "p",
    dataOverride: { delayMs: 700 },
  });
  await sleep(80);
  console.log(`  ① 遗留任务（canvasId=null）状态=${useQueueStore.getState().jobs[0].status}；活动=${activeJ().length}`);

  // 用户在活动画布 A 上对同一节点点"生成"（真实 hook）：作用域 (A,X) ≠ (null,X) → 守卫放行
  await handle();
  const jx = useQueueStore.getState().jobs;
  console.log(`  ② 点击后队列=${jx.map((j) => `${j.canvasId ?? "null"}:${j.status}`).join(", ")}`);
  console.log(`     标记：flowStore.queued=${JSON.stringify(markerIn(X))}（hook 已写 true）`);

  const w = watchMarkerDrop();
  await sleep(900);
  w.unsub();

  const drop = w.events[0];
  console.log(`  ③ 标记 true→false 的时刻：活动任务 = ${drop ? JSON.stringify(drop.active) : "（未发生）"}`);
  if (drop && drop.hasActiveOtherScope) {
    console.log("  RESULT: 复现——遗留任务结束时按 (null,X) 复核并清除了 nodeId=X 的标记，");
    console.log("          而 (A,X) 作用域的任务仍在排队/运行，标记本应保持 true。");
    return true;
  }
  console.log("  RESULT: 未复现");
  return false;
}

async function caseTwo() {
  console.log("");
  console.log("【形态 2】复制画布（node.id 相同）：画布 A 的任务结束抹掉**当前显示**的画布 B 节点的标记");
  const nodeA = mkNode();
  const nodeB = mkNode();
  useCanvasStore.setState({
    canvases: [
      { id: A, name: "A", nodes: [nodeA], edges: [] },
      { id: B, name: "B", nodes: [nodeB], edges: [] },
    ],
    activeCanvasId: A,
    _hasHydrated: true,
  });
  useFlowStore.setState({ nodes: [mkNode()], edges: [] });
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });

  // 画布 A 上的长任务
  useQueueStore.getState().enqueue({
    nodeId: X,
    canvasId: A,
    nodeLabel: "X",
    modelLabel: "m",
    promptPreview: "p",
    dataOverride: { delayMs: 700 },
  });
  await sleep(80);

  // 用户切到画布 B（App.tsx:121-163 用 canvasStore 的节点灌进 flowStore）
  useCanvasStore.setState({ activeCanvasId: B });
  useFlowStore.setState({ nodes: [mkNode()], edges: [] });

  // 在画布 B 上对同名节点点生成：作用域 (B,X) ≠ (A,X) → 放行；B 的 job 因额度被 A 占住而排队
  await handle();
  const jobs = useQueueStore.getState().jobs.map((j) => `${j.canvasId ?? "null"}:${j.status}`);
  console.log(`  ① 队列=${jobs.join(", ")}`);
  console.log(`     当前显示（画布 B）节点 X 的标记 flowStore.queued=${JSON.stringify(markerIn(X))}`);

  const w = watchMarkerDrop();
  await sleep(900);
  w.unsub();

  const drop = w.events[0];
  console.log(`  ② 标记 true→false 的时刻：活动任务 = ${drop ? JSON.stringify(drop.active) : "（未发生）"}`);
  console.log(`     flowStore.queued=${JSON.stringify(markerIn(X))}  canvasStore[B].queued=${JSON.stringify(markerInCanvas(B))}`);
  if (drop && drop.hasActiveOtherScope) {
    console.log("  RESULT: 复现——画布 A 的任务结束时清掉了 nodeId=X 的标记，命中的是当前显示画布 B 的节点对象，");
    console.log("          而画布 B 上该节点的任务仍在排队/运行。");
    return true;
  }
  console.log("  RESULT: 未复现");
  return false;
}

const r1 = await caseOne();
const r2 = await caseTwo();
console.log("");
console.log(`汇总：形态 1 复现=${r1}  形态 2 复现=${r2}`);
