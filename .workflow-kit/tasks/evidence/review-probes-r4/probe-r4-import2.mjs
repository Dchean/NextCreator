/**
 * 独立审查探针 R4-2b（审查者自写）：
 *  D) 模块图：queueStore 的传递静态依赖里是否有人 import queueStore（循环依赖）。
 *  E) 冷启动顺序：只 import queueStore（水合/恢复在其中触发）时，静态 import 的
 *     flowStore/canvasStore 是否已初始化、是否与外部 import 到的是**同一个** store 实例。
 *  F) cancel 的 queued 分支：载体只需"不为 true"；并测"标记只存在于画布副本"的场景。
 * 用法：node --experimental-strip-types probe-r4-import2.mjs
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");

function resolveSpec(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  const cands = [base, base + ".ts", base + ".tsx", base + ".js", path.join(base, "index.ts"), path.join(base, "index.tsx")];
  for (const cand of cands) {
    if (/\.(ts|tsx|js)$/.test(cand) && existsSync(cand)) return cand;
  }
  return null;
}
function importsOf(file) {
  const out = [];
  const src = readFileSync(file, "utf8");
  const re = /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^"']*?from\s+)?["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) out.push({ spec: m[1], dynamic: false });
  const reDyn = /import\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = reDyn.exec(src))) out.push({ spec: m[1], dynamic: true });
  return out;
}
const entry = path.join(SRC, "stores", "queueStore.ts");
const seen = new Map();
const bfsQ = [[entry, [entry]]];
const cycles = [];
const dynEdges = [];
while (bfsQ.length) {
  const [file, chain] = bfsQ.shift();
  if (seen.has(file)) continue;
  seen.set(file, chain);
  for (const { spec, dynamic } of importsOf(file)) {
    const target = resolveSpec(spec, file);
    if (!target) continue;
    if (dynamic) dynEdges.push(`${path.relative(SRC, file)} ->(dyn) ${path.relative(SRC, target)}`);
    if (target === entry) cycles.push([...chain, target].map((p) => path.relative(SRC, p)).join(" -> "));
    else if (!seen.has(target)) bfsQ.push([target, [...chain, target]]);
  }
}
console.log("========== D) 模块图 ==========");
console.log(`  queueStore 的传递静态依赖文件数=${seen.size}`);
console.log(`  回到 queueStore 的循环路径：${cycles.length === 0 ? "无（无循环依赖）" : cycles.join(" | ")}`);
console.log(`  传递依赖内的动态 import 边：${dynEdges.length === 0 ? "无" : dynEdges.join(" ; ")}`);
const mentions = [...seen.keys()].filter((file) => file !== entry && /queueStore/.test(readFileSync(file, "utf8")));
console.log(`  传递依赖中提及 queueStore 的文件：${mentions.map((file) => path.relative(SRC, file)).join(", ") || "无"}`);

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
  for (const cand of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(cand)) return cand;
  return p;
}
const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { success: false, error: "节点不存在" };
  await new Promise((r) => setTimeout(r, 10));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 30));
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

const X = "gen-x";
const A = "canvas-a";
const B = "canvas-b";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkNode = (queued) => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { prompt: "p", n: 1, status: "idle", label: "L", queued },
});
const CANVAS_SEED = JSON.stringify({
  state: { canvases: [{ id: A, name: "A", nodes: [mkNode(true)], edges: [] }], activeCanvasId: A, _hasHydrated: true },
  version: 0,
});
const QUEUE_SEED = JSON.stringify({
  state: { jobs: [{ id: "old-1", nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: 1 }], concurrency: 2 },
  version: 0,
});

console.log("");
console.log("========== E) 冷启动 / 模块顺序 ==========");
const ORDER = process.env.R4_ORDER || "queue-first";
globalThis.__NC_STORE_SEED__ =
  ORDER === "queue-first" ? { "generation-queue": QUEUE_SEED, "next-creator-canvases": CANVAS_SEED } : {};
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const P = (rel) => pathToFileURL(path.join(SRC, rel)).href;
let modQueue, modCanvas, modFlow;
if (ORDER === "canvas-first") {
  modCanvas = await import(P("stores/canvasStore.ts"));
  modQueue = await import(P("stores/queueStore.ts"));
  modFlow = await import(P("stores/flowStore.ts"));
} else if (ORDER === "flow-first") {
  modFlow = await import(P("stores/flowStore.ts"));
  modQueue = await import(P("stores/queueStore.ts"));
  modCanvas = await import(P("stores/canvasStore.ts"));
} else {
  modQueue = await import(P("stores/queueStore.ts"));
  modCanvas = await import(P("stores/canvasStore.ts"));
  modFlow = await import(P("stores/flowStore.ts"));
}
const q = modQueue, c = modCanvas, f = modFlow;
console.log(`  import 顺序=${ORDER}：queueStore 载入后其静态依赖可用：` +
  `canvases 是数组=${Array.isArray(c.useCanvasStore.getState().canvases)} flowNodes 是数组=${Array.isArray(f.useFlowStore.getState().nodes)}`);
const c2 = await import(P("stores/canvasStore.ts"));
const f2 = await import(P("stores/flowStore.ts"));
console.log(`  实例同一性：canvas=${c.useCanvasStore === c2.useCanvasStore} flow=${f.useFlowStore === f2.useFlowStore}`);

if (ORDER === "queue-first") {
  await sleep(500);
  const jobs = q.useQueueStore.getState().jobs;
  const cvs = c.useCanvasStore.getState().canvases;
  console.log(`  重启恢复：jobs=${jobs.map((j) => `${j.nodeId}:${j.status}`).join(",")}`);
  console.log(`  落盘副本 stamped true 是否被清：canvasStore[A].queued=${JSON.stringify(cvs.find((cv) => cv.id === A)?.nodes.find((n) => n.id === X)?.data?.queued)}（期望 false/undefined）`);
  console.log(`  flowStore 节点数=${f.useFlowStore.getState().nodes.length}（模拟 App.tsx setNodes 之前）`);
}

console.log("");
console.log("========== F) cancel 的 queued 分支 ==========");
const { useQueueStore } = q;
const { useCanvasStore } = c;
const { useFlowStore } = f;
const activeForX = () =>
  useQueueStore.getState().jobs.filter((j) => j.nodeId === X && (j.status === "queued" || j.status === "running"));
const anyTrue = () =>
  [useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued,
   ...useCanvasStore.getState().canvases.map((cv) => cv.nodes.find((n) => n.id === X)?.data?.queued)]
    .some((v) => v === true);
const canRun = (d) => Boolean(d?.prompt) && d?.status !== "loading" && !(d?.queued === true);

useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
useQueueStore.setState({ jobs: [], paused: true, concurrency: 1 });
useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
await sleep(10);
const j1 = useQueueStore.getState().jobs[0];
console.log(`  F1 排队中：任一载体为 true=${anyTrue()} 按钮可用=${canRun(useFlowStore.getState().nodes[0].data)}`);
useQueueStore.getState().cancel(j1.id);
await sleep(20);
const f1ok = activeForX().length === 0 && !anyTrue() && canRun(useFlowStore.getState().nodes[0].data);
console.log(`  F1 取消 queued 后：活动=${activeForX().length} 任一载体为 true=${anyTrue()} 按钮可用=${canRun(useFlowStore.getState().nodes[0].data)} → ${f1ok ? "PASS" : "FAIL"}`);

useQueueStore.setState({ jobs: [], paused: true });
useCanvasStore.setState({
  canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }, { id: B, name: "B", nodes: [mkNode()], edges: [] }],
  activeCanvasId: A,
});
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
useCanvasStore.setState({ activeCanvasId: B });
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
useQueueStore.getState().enqueue({ nodeId: X, canvasId: B, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
const two = useQueueStore.getState().jobs.filter((j) => j.nodeId === X);
useQueueStore.getState().cancel(two.find((j) => j.canvasId === A).id);
await sleep(20);
const keep = anyTrue();
console.log(`  F2 取消 A（B 仍 queued）后任一载体仍为 true=${keep} → ${keep ? "PASS（保留，正确）" : "FAIL（误清）"}`);
useQueueStore.getState().cancel(two.find((j) => j.canvasId === B).id);
await sleep(20);
console.log(`  F2 全部取消后：活动=${activeForX().length} 任一载体为 true=${anyTrue()} → ${activeForX().length === 0 && !anyTrue() ? "PASS" : "FAIL"}`);

useQueueStore.setState({ jobs: [], paused: true });
useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mkNode(true)], edges: [] }], activeCanvasId: A });
useFlowStore.setState({ nodes: [], edges: [] });
useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
await sleep(10);
const j3 = useQueueStore.getState().jobs.find((j) => j.nodeId === X);
console.log(`  F3 起点：flowStore 无该节点、画布副本 queued=true；job=${j3.status}`);
useQueueStore.getState().cancel(j3.id);
await sleep(20);
const cleared = useCanvasStore.getState().canvases.find((cv) => cv.id === A).nodes.find((n) => n.id === X)?.data?.queued;
console.log(`  F3 取消 queued 后 canvasStore[A].queued=${JSON.stringify(cleared)} → ${cleared !== true ? "PASS（早退判据没漏掉这份 true）" : "FAIL（漏清 = 永久锁）"}`);
