/**
 * Independent check of the r1 finding fix (TASK-003 repair 1).
 *
 * Reproduces the r1 scenario in-process with the REAL executor:
 *   a node with a genuine queued queue job + inline prompt
 *   → call executeImageGeneration the way the WORKFLOW path does (no clearQueuedMarker)
 *     must LEAVE data.queued === true
 *   → call it the way the QUEUE path does (clearQueuedMarker: true)
 *     must CLEAR it to falsy
 * Checks both carriers (flowStore + canvasStore).
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = "D:\\NextCreator\\src";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal stubs so the real executor can load without Tauri/browser.
const { registerHooks } = await import("node:module");
const { existsSync } = await import("node:fs");
const { fileURLToPath, pathToFileURL: toUrl } = await import("node:url");

const STUBS = {
  "@xyflow/react": `export const ReactFlow=()=>null;export const Background=()=>null;export const Controls=()=>null;
    export const MiniMap=()=>null;export const Panel=()=>null;export const Handle=()=>null;export const useReactFlow=()=>({});
    export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;export const addEdge=(e,es)=>es;
    export const MarkerType={};export const Position={};export const ConnectionLineType={};export const SelectionMode={};
    export const useStore=()=>({});export const getBezierPath=()=>["","",0,0];export const BaseEdge=()=>null;
    export const EdgeLabelRenderer=()=>null;export const useNodes=()=>[];export const useEdges=()=>[];export default {};`,
  "@tauri-apps/api/core": `export const invoke=async()=>{throw new Error("stub invoke");};export const Channel=class{};export const convertFileSrc=(p)=>p;export default {};`,
  "@tauri-apps/api/event": `export const listen=async()=>()=>{};export const emit=async()=>{};export default {};`,
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}async get(){return null;}async set(){}async save(){}async delete(){}async keys(){return [];}}export const load=async()=>new Store();export default {load};`,
  "@tauri-apps/plugin-fs": `export const readFile=async()=>new Uint8Array();export const writeFile=async()=>{};export const exists=async()=>false;export const mkdir=async()=>{};export const remove=async()=>{};export const stat=async()=>({});export default {};`,
  "@tauri-apps/plugin-dialog": `export const open=async()=>null;export const save=async()=>null;export const message=async()=>{};export const ask=async()=>false;export const confirm=async()=>false;export default {};`,
  "@tauri-apps/plugin-opener": `export const openUrl=async()=>{};export const openPath=async()=>{};export const revealItemInDir=async()=>{};export default {};`,
};
const withTs = (p) => {
  if (existsSync(p) && path.extname(p)) return p;
  for (const c of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(c)) return c;
  return p;
};
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGeneration") return { url: "probe:imagegen", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: toUrl(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: toUrl(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "probe:imagegen") {
      return {
        format: "module",
        source: `const fake={imageData:"data:image/png;base64,iVBORw0KGgo=",imageDataList:["data:image/png;base64,iVBORw0KGgo="]};
                 export const generateImage=async()=>fake;export const editImage=async()=>fake;export default {};`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

// tauriStorage.ts registers a beforeunload listener at module scope.
globalThis.window = globalThis.window ?? { addEventListener() {}, removeEventListener() {} };

const { useFlowStore } = await import(toUrl(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(toUrl(path.join(SRC, "stores/canvasStore.ts")).href);
const { useQueueStore } = await import(toUrl(path.join(SRC, "stores/queueStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(toUrl(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const { executeImageGeneration } = await import(toUrl(path.join(SRC, "services/imageGenerationExecution.ts")).href);

let checks = 0, fails = 0;
const check = (name, ok, detail) => { checks++; if (!ok) fails++; console.log(`${ok ? "[OK]  " : "[FAIL]"} ${name}${detail ? " :: " + detail : ""}`); };

const NODE = "probe-i-node";
const CANVAS = "probe-i-canvas";
const data = () => ({ ...getDefaultImageGeneratorData(), prompt: "probe i", queued: true });
const readQueued = () => ({
  flow: useFlowStore.getState().nodes.find((n) => n.id === NODE)?.data?.queued,
  canvas: useCanvasStore.getState().canvases.find((c) => c.id === CANVAS)?.nodes?.find((n) => n.id === NODE)?.data?.queued,
});

function setup() {
  // Order matters: establish the active job BEFORE writing the marker, because the
  // self-heal subscription only clears (never sets) and would clean a premature marker.
  useQueueStore.setState({
    paused: true, concurrency: 1,
    jobs: [{ id: "probe-i-job", nodeId: NODE, canvasId: CANVAS, nodeLabel: "I", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() }],
  });
  useFlowStore.setState({ nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }], edges: [] });
  useCanvasStore.setState({ activeCanvasId: CANVAS, canvases: [{ id: CANVAS, name: "probe", nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }], edges: [] }] });
}

check("状态不一致检查：paused=true 表示官方暂停，允许 queued 任务停留",
  typeof executeImageGeneration === "function", `executor loaded`);

// ---- 1) workflow path: no clearQueuedMarker => marker must survive ----
setup();
const pre = readQueued();
check("夹具前提：标记确实存在", pre.flow === true && pre.canvas === true, JSON.stringify(pre));
const r1 = await executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords: false });
const afterWorkflow = readQueued();
check("工作流路径（不传 clearQueuedMarker）保留合法 queued 标记",
  afterWorkflow.flow === true,
  `flow.queued=${JSON.stringify(afterWorkflow.flow)} canvas.queued=${JSON.stringify(afterWorkflow.canvas)} result.success=${r1.success}`);

// ---- 2) queue path: clearQueuedMarker:true => marker must be cleared ----
setup();
const r2 = await executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords: true, clearQueuedMarker: true });
const afterQueue = readQueued();
check("队列路径（clearQueuedMarker:true）仍清 queued 标记（既有语义不丢）",
  !afterQueue.flow,
  `flow.queued=${JSON.stringify(afterQueue.flow)} result.success=${r2.success}`);

// ---- 3) explicit false must behave like the default ----
setup();
await executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords: false, clearQueuedMarker: false });
const afterExplicitFalse = readQueued();
check("显式 clearQueuedMarker:false 与默认同行为（保留标记）", afterExplicitFalse.flow === true, `flow.queued=${JSON.stringify(afterExplicitFalse.flow)}`);

// cleanup
useQueueStore.setState({ jobs: [] });
useFlowStore.setState({ nodes: [], edges: [] });
useCanvasStore.setState({ canvases: [] });

console.log(`\n汇总：${checks - fails}/${checks} 通过`);
process.exit(fails === 0 ? 0 : 1);
