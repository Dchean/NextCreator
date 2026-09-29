/**
 * 自建验证探针（REPAIR R3）：证明 probe-r3-abnormal-scope-clear.mjs 的判据是**结构性假阳性**。
 *
 * 该探针的判据是：
 *     "标记 true→false 的那一刻，nodeId 上是否还有别的 active 任务（hasActiveOtherScope）"
 * 但**忠实执行器在任务启动时会合法地写 `queued:false`**（imageGenerationExecution.ts:265-269：
 * `updateNodeDataWithCanvas(nodeId, canvasId, { status: "loading", queued: false, ... })`）。
 * 而任务一旦开始跑，它自己就是 active（status='running'）→ 该判据**必然**为 true。
 * 也就是说：哪怕场景里**完全没有**复制画布、没有第二个作用域、实现 100% 正确，
 * 只要节点上那个被标记的任务真的开始执行，该判据就会判"复现"。
 *
 * 本探针用一个**最简单的单画布单节点**场景把这个假阳性直接演示出来：
 *   · 单画布 c1、单节点 X、一次生成；
 *   · 忠实执行器（启动时写 queued:false + status=loading）；
 *   · 记录 true→false，并用**该探针的原判据**评估 → 会判"复现"，
 *     而这显然不是缺陷：那一刻正是 X 自己的任务从 queued 变成 running，标记本就该离开 true。
 *
 * 用法：node --experimental-strip-types probe-r3-criterion-falsepositive.mjs
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
// 与 probe-r3-abnormal-scope-clear.mjs **逐字相同**的忠实执行器
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
const C1 = "c1";
const mkNode = () => ({
  id: X,
  type: "imageGeneratorNode",
  position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle" },
});

let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution(X, useFlowStore.getState().nodes[0].data);
  handle = handleGenerate;
  return null;
}

// 单画布、单节点：场景里根本不存在"另一个作用域"，也没有任何复制画布。
useCanvasStore.setState({
  canvases: [{ id: C1, name: "c1", nodes: [mkNode()], edges: [] }],
  activeCanvasId: C1,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
renderToStaticMarkup(React.createElement(Probe));

const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const activeJ = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");

// 逐字复刻 probe-r3-abnormal-scope-clear.mjs 的 watchMarkerDrop 判据
const events = [];
let prev = marker();
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

console.log("单画布、单节点（无复制画布、无第二个作用域）、忠实执行器：");
console.log("  ① 点击生成 → hook 写 queued:true");
await handle();
console.log(`     标记=${JSON.stringify(marker())}  队列=${activeJ().map((j) => j.status).join(", ")}`);

await sleep(400);
unsub();
const drop = events[0];
console.log("");
console.log("  ② 该探针的判据记录到的 true→false：");
console.log(`     掉标记的瞬间 active 任务 = ${drop ? JSON.stringify(drop.active) : "（未发生）"}`);
console.log(`     hasActiveOtherScope = ${drop ? drop.hasActiveOtherScope : "n/a"}`);
console.log("");
if (drop && drop.hasActiveOtherScope) {
  console.log("RESULT: 该判据在**完全正确**的实现上也会判\"复现\"。");
  console.log("        原因：忠实执行器在任务启动时合法地写 queued:false（status→loading），");
  console.log("        而那一刻该任务自己正 active（running）→ hasActiveOtherScope 必然为 true。");
  console.log("        这与\"另一个作用域被误清\"无关：这里压根不存在第二个作用域。");
  console.log("        故 probe-r3-abnormal-scope-clear.mjs 的 复现=true 不构成缺陷证据；");
  console.log("        判定\"是否存在误清\"要用 probe-r3-abnormal-attribution.mjs（按同一次写入里");
  console.log("        status 是否变成 loading 归因）与 probe-r3-unified-scope-verify.mjs（用不写节点");
  console.log("        数据的执行器，排除执行器写法的干扰）。");
} else {
  console.log("RESULT: 未出现（该判据未被触发）。");
}
process.exitCode = 0;
