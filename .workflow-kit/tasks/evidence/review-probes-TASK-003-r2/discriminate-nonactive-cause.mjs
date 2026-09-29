/**
 * 判定「非活动画布标记被清」的真因：是产品缺陷，还是探针夹具与 queueStore 的
 * **重启恢复（REQ-001）** 撞车？
 *
 * 假设：probe-limiter-cancel-r2 里 queueStore 是**在该 block 内首次 import** 的，
 * 于是 onRehydrateStorage → recoverPersistedQueuedJobs() 在 import 之后才异步跑；
 * 若探针紧接着塞进一个 status:"queued" 的任务，恢复逻辑会把它当成"重启前遗留的任务"
 * 派发（pump → executeImageGeneration({clearQueuedMarker:true})），从而**合法地**清掉标记。
 *
 * 判定方法：同一个夹具，两种 import 时机 ——
 *   V1: queueStore 在脚本顶部 import（恢复早已跑完，无遗留任务）
 *   V2: queueStore 在塞任务之前才 import（恢复与夹具撞车）
 * 若 V1 保留、V2 被清，则真因是夹具时序，不是产品缺陷。
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = process.env.NC_ROOT ? path.resolve(process.env.NC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");
const V = process.env.NC_VARIANT || "V1";
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
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGeneration") return { url: "mutant:gen", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const base = fileURLToPath(new URL(spec, context.parentURL));
      const t = withTs(base);
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:gen") {
      return { format: "module", shortCircuit: true, source: `
        const fake = { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="], text: "t" };
        export const generateImage = async () => { (globalThis.__NC_PROVIDER_CALLS__ ||= []).push("gen"); return fake; };
        export const editImage = generateImage; export default {};` };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const { nodeExecutor } = await import(pathToFileURL(path.join(SRC, "services/nodeExecutor.ts")).href);

let useQueueStore = null;
if (V === "V1") {
  ({ useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href));
  await new Promise((r) => setTimeout(r, 900));   // 让恢复逻辑彻底跑完
}

const OTHER = "v-other", ACTIVE = "v-active", NODE2 = "v-node2";
const data = () => ({ ...getDefaultImageGeneratorData(), prompt: "p", queued: true });
const readOther = () => {
  const c = useCanvasStore.getState().canvases.find((x) => x.id === OTHER);
  const n = c && c.nodes.find((x) => x.id === NODE2);
  return n ? n.data.queued : "NO_NODE";
};

if (V === "V2") {
  ({ useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href));
}
if (V === "V3") {
  // 与 V2 同样"晚 import"，但额外等水合/恢复彻底跑完**再**塞夹具
  ({ useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href));
  await new Promise((r) => setTimeout(r, 900));
}
if (V === "V4") {
  // V2 的基础上插桩：观察 jobs 数组长度随时间的抖动（水合覆盖的指纹）
  ({ useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href));
  const seen = [];
  useQueueStore.subscribe((s) => { seen.push(s.jobs.map((j) => `${j.id}:${j.status}`).join("|") || "(empty)"); });
  globalThis.__NC_JOBS_SEEN__ = seen;
}
useQueueStore.setState({
  paused: true, concurrency: 1,
  jobs: [{ id: "v-job", nodeId: NODE2, canvasId: OTHER, nodeLabel: "O", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() }],
});
useFlowStore.setState({ nodes: [], edges: [] });
useCanvasStore.setState({
  activeCanvasId: ACTIVE,
  canvases: [
    { id: ACTIVE, name: "active", nodes: [], edges: [] },
    { id: OTHER, name: "other", nodes: [{ id: NODE2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }], edges: [] },
  ],
});
const pre = readOther();
globalThis.__NC_PROVIDER_CALLS__ = [];
await nodeExecutor.executeNode({ id: NODE2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }, OTHER);
const mid = readOther();
await new Promise((r) => setTimeout(r, 900));   // 给恢复逻辑充分时间
const post = readOther();
const jobs = useQueueStore.getState().jobs.map((j) => `${j.id}:${j.status}`);

console.log(`VARIANT=${V}`);
console.log(`  前置 canvas副本.queued = ${JSON.stringify(pre)}`);
console.log(`  执行器跑完立刻         = ${JSON.stringify(mid)}`);
console.log(`  再等 900ms 后          = ${JSON.stringify(post)}`);
console.log(`  队列 jobs              = ${JSON.stringify(jobs)}`);
console.log(`  provider 被调用次数    = ${(globalThis.__NC_PROVIDER_CALLS__ || []).length}`);
console.log(`  结论                   = ${post === true ? "标记被保留" : "标记被清除"}`);
if (V === "V4") {
  console.log(`  jobs 变化序列          = ${JSON.stringify(globalThis.__NC_JOBS_SEEN__)}`);
  console.log(`  该 nodeId 是否有活动任务 = ${useQueueStore.getState().jobs.some((j) => j.nodeId === NODE2 && (j.status === "queued" || j.status === "running"))}`);
}
