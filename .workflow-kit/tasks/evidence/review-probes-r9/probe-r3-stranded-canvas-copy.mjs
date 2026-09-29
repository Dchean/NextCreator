/**
 * 自建验证探针（REPAIR R3）：谓词（按 nodeId）与清除落点（按 canvasId 选一份副本）**作用域不对齐**
 * 时，是否会把"另一张画布上的持久化副本"永久留在 queued:true。
 *
 * 场景（全部是真实入口）：
 *   · 画布 A、画布 B 各有同名节点 X（duplicateCanvas 保留 node.id）；
 *   · 真实 App 里 App.tsx:170 的 800ms 防抖会把 flowStore 的节点写进**当前活动画布**，
 *     所以"用户在 A 上点生成并停留一会儿"会让 canvasStore[A].queued 也变成 true（这里直接预置该状态）；
 *   · A 的 job 先跑（concurrency=1），B 的 job 排队；A 结束时 B 仍有 queued 任务
 *     → 谓词（nodeId）会**正确**地阻止清除（F-R3-1 的修复方向）；
 *   · 随后 B 的 job 结束时，清除按 canvasId=B 只清 flowStore + canvasStore[B]，
 *     canvasStore[A] 的那份 queued:true 就**没有任何路径**会再清它。
 *
 * 后果（与 REQ-001 同类）：该副本是**落盘**的那一份，重启后 App.tsx:154 用 setNodes 把它载回
 * flowStore → 节点显示"排队中"、按钮禁用，而队列里该节点已无任何任务；此时 isRecoverableJob
 * 不再匹配（终态），恢复逻辑不会介入 → 永久锁。
 *
 * 用法：node --experimental-strip-types probe-r3-stranded-canvas-copy.mjs
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
// 执行器不写节点数据：所有标记写入都只可能来自 queueStore 的清除路径。
const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  await new Promise((r) => setTimeout(r, 15));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 200));
  return { success: true, cancelled: false };
};
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);
`;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec-nodewrite", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec-nodewrite") return { format: "module", source: EXEC_SRC, shortCircuit: true };
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
const A = "canvas-a";
const B = "canvas-b";
const mkNode = (queued) => ({
  id: X,
  type: "imageGeneratorNode",
  position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", queued },
});

// 预置：两张画布的副本都带着 queued:true（= 用户在两边的标记为 true 时都停留过 ≥800ms，
// App.tsx:170 的防抖把 flowStore 的节点分别写进过各自的活动画布）
useCanvasStore.setState({
  canvases: [
    { id: A, name: "A", nodes: [mkNode(true)], edges: [] },
    { id: B, name: "B", nodes: [mkNode(true)], edges: [] },
  ],
  activeCanvasId: B,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [mkNode(true)], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });

const markerIn = (cid) =>
  useCanvasStore.getState().canvases.find((c) => c.id === cid)?.nodes.find((n) => n.id === X)?.data?.queued;
const activeForX = () =>
  useQueueStore.getState().jobs.filter((j) => j.nodeId === X && (j.status === "queued" || j.status === "running"));

// A 的 job（短）先跑；B 的 job（长）排队（concurrency=1）
useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 120 } });
useQueueStore.getState().enqueue({ nodeId: X, canvasId: B, nodeLabel: "X", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 300 } });
await sleep(60);
console.log(`① 启动：${useQueueStore.getState().jobs.map((j) => `${j.canvasId}:${j.status}`).join(", ")}`);
console.log(`   canvasStore[A].queued=${JSON.stringify(markerIn(A))}  canvasStore[B].queued=${JSON.stringify(markerIn(B))}  flowStore.queued=${JSON.stringify(useFlowStore.getState().nodes[0].data.queued)}`);

console.log("");
console.log("② A 的 job 结束（此刻 B 仍有 queued 任务 → 谓词应当阻止清除，这是 F-R3-1 的修复方向）");
await sleep(260);
console.log(`   ${useQueueStore.getState().jobs.map((j) => `${j.canvasId}:${j.status}`).join(", ")}`);

console.log("");
console.log("③ 等一切结束（B 的 job 也会结束，其 finally 会做一次条件清除）");
await sleep(1200);
const active = activeForX();
console.log(`   队列=${useQueueStore.getState().jobs.map((j) => `${j.canvasId}:${j.status}`).join(", ")}  nodeId=X 的活动任务=${active.length}`);
console.log(`   flowStore.queued=${JSON.stringify(useFlowStore.getState().nodes[0].data.queued)}`);
console.log(`   canvasStore[A].queued=${JSON.stringify(markerIn(A))}  ← 落盘的那一份（重启后由 App.tsx:154 载回 flowStore）`);
console.log(`   canvasStore[B].queued=${JSON.stringify(markerIn(B))}`);

const stranded = active.length === 0 && markerIn(A) === true;
console.log("");
if (stranded) {
  // 模拟重启：App.tsx:154 用 canvasStore 的节点灌进 flowStore
  useCanvasStore.setState({ activeCanvasId: A });
  useFlowStore.setState({ nodes: [mkNode(markerIn(A))], edges: [] });
  const d = useFlowStore.getState().nodes[0].data;
  const canRun = Boolean(d.prompt) && d.status !== "loading" && !(d.queued === true);
  console.log("RESULT: 复现——该 nodeId 已无任何活动任务，但画布 A 的持久化副本仍是 queued:true。");
  console.log("        重启/切回画布 A 后（App.tsx:154 setNodes）节点显示“排队中”、按钮禁用：");
  console.log(`        flowStore.queued=${JSON.stringify(d.queued)}  ImageGeneratorNode.canRun=${canRun}`);
  console.log("        isRecoverableJob 不再匹配（终态）→ 恢复逻辑不会介入 → 永久锁。");
} else {
  console.log("RESULT: 未复现（该 nodeId 无活动任务时，所有载体的标记都已复位）。");
}
process.exitCode = stranded ? 1 : 0;
