/**
 * 独立审查探针 R4-5：B 场景（A 运行 + B 同 nodeId 排队）的**逐次写入归因**
 * 执行器为 silent（绝不写节点数据），因此任何 queued 变化都必须能追到具体调用方。
 * 记录 useFlowStore.setState / updateNodeData 与 canvasStore.setState 的每一次调用及其栈顶帧。
 * 用法：node --experimental-strip-types probe-r4-b.mjs
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
  for (const cand of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(cand)) return cand;
  return p;
}
const SILENT = `
export const executeImageGeneration = async (nodeId, options) => {
  await new Promise((r) => setTimeout(r, 10));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 40));
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
    if (url === "mutant:exec") return { format: "module", source: SILENT, shortCircuit: true };
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
const { useImageGeneratorExecution } = await import(pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);

const X = "gen-x";
const A = "canvas-a";
const B = "canvas-b";
const mkNode = (queued) => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L", queued },
});
const PROBE_DATA = { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" };

const T0 = Date.now();
const log = [];
const frames = (skip) => {
  const st = String(new Error().stack || "").split("\n").slice(1);
  const framesOut = [];
  for (const f of st) {
    if (/probe-r4-b\.mjs/.test(f)) continue;
    const m = f.match(/([^\\/]+\.(?:ts|tsx|js|mjs)):(\d+):(\d+)/);
    if (m) framesOut.push(`${m[1]}:${m[2]}`);
    if (framesOut.length >= 4) break;
  }
  return framesOut.join(" <- ");
};
function instrument() {
  const origSet = useFlowStore.setState;
  useFlowStore.setState = (partial, replace) => {
    const keys = partial && typeof partial === "object" ? Object.keys(partial).join(",") : String(partial);
    const queued = JSON.stringify(partial?.nodes?.map?.((n) => n?.data?.queued));
    log.push({ t: Date.now() - T0, via: "flowStore.setState", keys, queued, frames: frames() });
    return origSet(partial, replace);
  };
  const origUpdate = useFlowStore.getState().updateNodeData;
  const wrapUpdate = (id, patch) => {
    log.push({ t: Date.now() - T0, via: "updateNodeData", keys: Object.keys(patch || {}).join(","), queued: JSON.stringify(patch?.queued), frames: frames() });
    return origUpdate(id, patch);
  };
  useFlowStore.setState({ updateNodeData: wrapUpdate });
  const origCSet = useCanvasStore.setState;
  useCanvasStore.setState = (partial, replace) => {
    log.push({ t: Date.now() - T0, via: "canvasStore.setState", keys: Object.keys(partial || {}).join(","), queued: JSON.stringify(partial?.canvases?.map?.((c) => c?.nodes?.map?.((n) => n?.data?.queued))), frames: frames() });
    return origCSet(partial, replace);
  };
}
instrument();

let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution(X, PROBE_DATA);
  handle = handleGenerate;
  return null;
}
const active = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");
const markerFlow = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;

useCanvasStore.setState({
  canvases: [{ id: A, name: "A", nodes: [mkNode(true)], edges: [] }, { id: B, name: "B", nodes: [mkNode(true)], edges: [] }],
  activeCanvasId: A,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [mkNode(true)], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
log.length = 0;

useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 400 } });
await sleep(60);
useCanvasStore.setState({ activeCanvasId: B });
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
renderToStaticMarkup(React.createElement(Probe));
const handleStart = Date.now() - T0;
await handle();
console.log(`handle() 耗时约 ${Date.now() - T0 - handleStart}ms`);
console.log(`点击后 t=${Date.now() - T0}ms：标记=${JSON.stringify(markerFlow())} 队列=${active().map((j) => `${j.canvasId}:${j.status}`).join(",")}`);

const watch = [];
log.length = 0;
let prevFlow = markerFlow();
for (let i = 0; i < 80; i++) {
  await sleep(10);
  const cur = markerFlow();
  const act = active().map((j) => `${j.canvasId}:${j.status}`);
  if (cur !== prevFlow) {
    watch.push({ t: Date.now() - T0, from: prevFlow, to: cur, act: act.join(",") });
    prevFlow = cur;
  }
  if (act.length === 0 && i > 5) break;
}
console.log("");
console.log("标记变化时间线：");
for (const w of watch) console.log(`  t=${w.t}ms  ${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)}   此刻活动任务=[${w.act}]`);
console.log("");
console.log("期间的写入明细：");
for (const e of log) console.log(`  t=${e.t}ms ${e.via} keys=${e.keys} queued=${e.queued}  frames=${e.frames}`);
console.log("");
console.log(`最终：flow=${JSON.stringify(markerFlow())} canvasA=${JSON.stringify(useCanvasStore.getState().canvases.find((c) => c.id === A).nodes.find((n) => n.id === X)?.data?.queued)} canvasB=${JSON.stringify(useCanvasStore.getState().canvases.find((c) => c.id === B).nodes.find((n) => n.id === X)?.data?.queued)} 活动=${active().length}`);
