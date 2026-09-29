/**
 * 自建归因探针（REPAIR R3 / F-R3-1）
 *
 * 背景：probe-r3-abnormal-scope-clear.mjs 的判据是"标记 true→false 的瞬间，nodeId=X 是否还有
 * 其它 active 任务"。这个判据**无法区分两种截然不同的原因**：
 *   (a) queueStore 的清除路径误清（= F-R3-1 的缺陷）；或
 *   (b) 同一节点的**另一个任务真的开始跑了**，执行器在启动时合法地写 `queued:false`
 *       （imageGenerationExecution.ts:265-269 的真实行为）。
 * 因为 (b) 也会让"掉标记的瞬间还有 active 任务"成立，所以该探针在修复前后都判"复现"。
 *
 * 本探针用同一套 faithful 执行器，但在每一次 true→false 的**同一次写入**里额外看 `status`：
 *   · status 变成 "loading"  → 执行器启动写（合法，与标记语义一致：任务已不在排队）
 *   · status 没有变化，只有 queued 被写成 false → **只可能**是 queueStore 的清除路径
 * 于是可以判定：是否存在"纯 queued 清除 + 当时仍有 nodeId=X 的 active 任务"这种 F-R3-1 签名。
 *
 * 用法：node --experimental-strip-types probe-r3-abnormal-attribution.mjs
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

// 与 probe-r3-abnormal-scope-clear.mjs **逐字相同**的 faithful 执行器
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

const nodeOf = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data ?? {};
const activeForX = () =>
  useQueueStore.getState().jobs.filter((j) => j.nodeId === X && (j.status === "queued" || j.status === "running"));

/**
 * 记录每一次 true→false，并按"同一次写入里 status 是否变成 loading"归因。
 * queueStore 的清除只写 queued 一个字段，绝不会写 status。
 */
function watchAttributed() {
  const events = [];
  let prevQ = nodeOf().queued;
  let prevStatus = nodeOf().status;
  const unsub = useFlowStore.subscribe((s) => {
    const d = s.nodes.find((n) => n.id === X)?.data ?? {};
    const q = d.queued;
    const st = d.status;
    if (q !== prevQ || st !== prevStatus) {
      if (prevQ === true && q !== true) {
        const act = activeForX().map((j) => `${j.canvasId ?? "null"}:${j.status}`);
        events.push({
          kind: st !== prevStatus && st === "loading" ? "executor-start" : "queue-clear",
          status: `${prevStatus}→${st}`,
          active: act,
          misClear: !(st !== prevStatus && st === "loading") && act.length > 0,
        });
      }
      prevQ = q;
      prevStatus = st;
    }
  });
  return { events, unsub };
}

let failures = 0;
function report(title, events) {
  console.log(`  ${title}`);
  if (events.length === 0) console.log("    没有发生任何 true→false");
  for (const e of events) {
    console.log(
      `    · 归因=${e.kind}  status ${e.status}  当时 nodeId=X 的 active 任务=${JSON.stringify(e.active)}` +
        (e.misClear ? "   ← F-R3-1 签名（纯 queued 清除且仍有活动任务）" : "")
    );
  }
  const mis = events.filter((e) => e.misClear);
  console.log(`    F-R3-1 签名出现次数 = ${mis.length}（期望 0）`);
  if (mis.length > 0) failures++;
}

// ===========================================================================
console.log("【形态 1】canvasId=null 的遗留任务 vs 活动画布 canvas-a 上同名节点的排队任务");
useCanvasStore.setState({
  canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }],
  activeCanvasId: A,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
renderToStaticMarkup(React.createElement(Probe));

useQueueStore.getState().enqueue({ nodeId: X, canvasId: null, nodeLabel: "X", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 700 } });
await sleep(80);
await handle();
const w1 = watchAttributed();
await sleep(1100);
w1.unsub();
report("每次 true→false 的归因：", w1.events);

// ===========================================================================
console.log("");
console.log("【形态 2】复制画布：画布 A 的 X 任务结束 vs 画布 B（同名节点 X）的排队任务");
useCanvasStore.setState({
  canvases: [
    { id: A, name: "A", nodes: [mkNode()], edges: [] },
    { id: B, name: "B", nodes: [mkNode()], edges: [] },
  ],
  activeCanvasId: A,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
renderToStaticMarkup(React.createElement(Probe));

useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 700 } });
await sleep(80);
useCanvasStore.setState({ activeCanvasId: B });
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
renderToStaticMarkup(React.createElement(Probe));
await handle();
const w2 = watchAttributed();
await sleep(1100);
w2.unsub();
report("每次 true→false 的归因：", w2.events);

console.log("");
if (failures === 0) {
  console.log("RESULT: 两个形态里都没有出现 F-R3-1 签名 —— 标记的每一次 true→false 都能归因到");
  console.log("        「执行器启动时合法地写 queued:false」（同一次写入里 status 变成 loading），");
  console.log("        没有任何一次是 queueStore 在仍有活动任务时做的纯 queued 清除。");
  console.log("        因此 probe-r3-abnormal-scope-clear.mjs 判\"复现\"是它判据的假阳性：");
  console.log("        它只看\"掉标记时还有没有 active 任务\"，而另一任务真的开始跑时这两种情况无法区分。");
} else {
  console.log(`RESULT: 仍有 ${failures} 个形态出现 F-R3-1 签名（误清）。`);
}
process.exitCode = failures === 0 ? 0 : 1;
