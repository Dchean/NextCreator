// 审查者探针：REQ-006 在工作流路径上的可见终态
// 问题：workflowEngine 取消后 NodeExecutionResult 必须是 {success:false,error:"已取消"}，
//      节点状态不得停在 loading/queued，且不得写入本次产物。
// 用法：node --experimental-strip-types probe-workflow-cancel.mjs <out.json>
import { registerHooks } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const OUT = process.argv[2] || "probe-workflow-cancel.json";
const root = process.cwd();
const SRC = path.join(root, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.__NC_STORE_SEED__ = {};

const STUBS = {
  "@xyflow/react": `export const ReactFlow=()=>null;export const Background=()=>null;export const Controls=()=>null;
    export const MiniMap=()=>null;export const Panel=()=>null;export const Handle=()=>null;export const useReactFlow=()=>({});
    export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;export const addEdge=(e,es)=>es;
    export const MarkerType={};export const Position={};export const ConnectionLineType={};export const SelectionMode={};
    export const useStore=()=>({});export const getBezierPath=()=>["","",0,0];export const BaseEdge=()=>null;
    export const EdgeLabelRenderer=()=>null;export const useNodes=()=>[];export const useEdges=()=>[];export default {};`,
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
          import { generateImage as realGenerateImage, editImage as realEditImage } from ${real};
          export * from ${real};
          async function call() {
            await new Promise((r) => setTimeout(r, 900));   // 长请求：给取消留出窗口
            return { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="] };
          }
          export const generateImage = async (...a) => call();
          export const editImage = async (...a) => call();
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const limiter = await import(pathToFileURL(path.join(SRC, "services/concurrencyLimiter.ts")).href);
const { WorkflowEngine } = await import(pathToFileURL(path.join(SRC, "services/workflowEngine.ts")).href);

const CANVAS = "probe-cancel-canvas";
const NODE = "wf-cancel-node";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nodes = [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...getDefaultImageGeneratorData(), prompt: "cancel probe", model: "gemini-2.5-flash-image" } }];
useFlowStore.setState({ nodes, edges: [] });
useCanvasStore.setState({ activeCanvasId: CANVAS, canvases: [{ id: CANVAS, name: "p", nodes, edges: [] }] });

limiter.resetGlobalConcurrencyLimiter();
const engine = new WorkflowEngine({ maxParallelNodes: 3, skipInputNodes: true });
const run = engine.executeWorkflow(nodes, [], CANVAS);
await sleep(250);
// 取消整个工作流（WorkflowControls 的停止按钮走的就是这条 API）
engine.cancel ? engine.cancel() : engine.abort?.();
const ctx = await run;
await sleep(300);

const d = (useFlowStore.getState().nodes.find((n) => n.id === NODE) || {}).data || {};
const out = {
  root,
  engineStatus: ctx.status,
  nodeStatusFromEngine: ctx.nodeStatuses[NODE] ?? null,
  errors: ctx.errors,
  nodeData: {
    status: d.status ?? null,
    error: d.error ?? null,
    outputImage: d.outputImage ?? null,
    outputImagePath: d.outputImagePath ?? null,
    outputImages: d.outputImages ?? null,
    outputImagePaths: d.outputImagePaths ?? null,
    runRecords: (d.runRecords || []).length,
    queued: d.queued ?? null,
  },
  limiterAfter: { inFlight: limiter.getInFlightCount(), waiters: limiter.getWaiterCount() },
};
writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
console.log(JSON.stringify(out, null, 2));
