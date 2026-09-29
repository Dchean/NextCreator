/**
 * 鐙珛瀹℃煡鎺㈤拡 R4-5锛欱 鍦烘櫙锛圓 杩愯 + B 鍚?nodeId 鎺掗槦锛夌殑**閫愭鍐欏叆褰掑洜**
 * 鎵ц鍣ㄤ负 silent锛堢粷涓嶅啓鑺傜偣鏁版嵁锛夛紝鍥犳浠讳綍 queued 鍙樺寲閮藉繀椤昏兘杩藉埌鍏蜂綋璋冪敤鏂广€? * 璁板綍 useFlowStore.setState / updateNodeData 涓?canvasStore.setState 鐨勬瘡涓€娆¤皟鐢ㄥ強鍏舵爤椤跺抚銆? * 鐢ㄦ硶锛歯ode --experimental-strip-types probe-r4-b.mjs
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
useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
log.length = 0;

useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 120 } });
await sleep(60);
useCanvasStore.setState({ activeCanvasId: B });
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
renderToStaticMarkup(React.createElement(Probe));
const handleStart = Date.now() - T0;
await handle();
console.log(`handle() 鑰楁椂绾?${Date.now() - T0 - handleStart}ms`);
console.log(`鐐瑰嚮鍚?t=${Date.now() - T0}ms锛氭爣璁?${JSON.stringify(markerFlow())} 闃熷垪=${active().map((j) => `${j.canvasId}:${j.status}`).join(",")}`);

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
console.log("鏍囪鍙樺寲鏃堕棿绾匡細");
for (const w of watch) console.log(`  t=${w.t}ms  ${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)}   姝ゅ埢娲诲姩浠诲姟=[${w.act}]`);
console.log("");
console.log("鏈熼棿鐨勫啓鍏ユ槑缁嗭細");
for (const e of log) console.log(`  t=${e.t}ms ${e.via} keys=${e.keys} queued=${e.queued}  frames=${e.frames}`);
console.log("");
console.log(`鏈€缁堬細flow=${JSON.stringify(markerFlow())} canvasA=${JSON.stringify(useCanvasStore.getState().canvases.find((c) => c.id === A).nodes.find((n) => n.id === X)?.data?.queued)} canvasB=${JSON.stringify(useCanvasStore.getState().canvases.find((c) => c.id === B).nodes.find((n) => n.id === X)?.data?.queued)} 娲诲姩=${active().length}`);

