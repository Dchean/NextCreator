/**
 * 判定「晚 import + 立刻塞夹具 → 标记被清」的真因。
 *
 * 假设：queueStore 的 persist 水合是**异步**的（tauriStorage 是异步 storage）。
 * 若在 import 之后立刻 setState 塞入 job，随后水合完成会用**持久化里的 jobs**
 * （本探针 __NC_STORE_SEED__ 为空 → 空数组）覆盖内存，于是"该 nodeId 有活动任务"
 * 这一前提短暂消失；此时执行器写 flowStore 触发自愈订阅，谓词按"无活动任务"放行 → 清标记。
 *
 * 那一瞬是**水合还没完成**的状态，真实应用里不可能"先入队、后水合"（入队必须由用户点击，
 * 发生在 App 启动完成之后）。因此若时间线显示"清标记的那一刻 jobs 为空/不含该 nodeId"，
 * 则真因是探针夹具与水合的竞态，不是产品缺陷。
 *
 * 时间线记录：queueStore 每次变化（jobs + hasHydrated）、flowStore nodes 身份变化、
 * canvasStore 中目标副本 queued 的值。
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = process.env.NC_ROOT ? path.resolve(process.env.NC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
        export const generateImage = async () => fake; export const editImage = generateImage; export default {};` };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const { nodeExecutor } = await import(pathToFileURL(path.join(SRC, "services/nodeExecutor.ts")).href);

const OTHER = "t-other", ACTIVE = "t-active", NODE2 = "t-node2";
const data = () => ({ ...getDefaultImageGeneratorData(), prompt: "p", queued: true });
const readOther = () => {
  const c = useCanvasStore.getState().canvases.find((x) => x.id === OTHER);
  const n = c && c.nodes.find((x) => x.id === NODE2);
  return n ? n.data.queued : "NO_NODE";
};

const t0 = Date.now();
const timeline = [];
const at = () => `+${String(Date.now() - t0).padStart(4)}ms`;

// ---- 晚 import（复现 V2 时序）----
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
timeline.push(`${at()} [import queueStore] hasHydrated=${useQueueStore.persist.hasHydrated()} jobs=${JSON.stringify(useQueueStore.getState().jobs.map((j) => j.status))}`);

useQueueStore.subscribe((s) => {
  const active = s.jobs.some((j) => j.nodeId === NODE2 && (j.status === "queued" || j.status === "running"));
  timeline.push(`${at()} [queueStore 变化] jobs=${JSON.stringify(s.jobs.map((j) => `${j.id}:${j.status}`))} hasHydrated=${useQueueStore.persist.hasHydrated()} 该节点active=${active}`);
});
useCanvasStore.subscribe(() => {
  timeline.push(`${at()} [canvasStore 变化] 目标副本.queued=${JSON.stringify(readOther())}`);
});
useFlowStore.subscribe((s, p) => {
  if (s.nodes !== p.nodes) timeline.push(`${at()} [flowStore nodes 换身份] 节点数=${s.nodes.length} 目标副本.queued=${JSON.stringify(readOther())}`);
});

// ---- 夹具（与 V2 完全一致：import 之后立刻塞）----
useQueueStore.setState({
  paused: true, concurrency: 1,
  jobs: [{ id: "t-job", nodeId: NODE2, canvasId: OTHER, nodeLabel: "O", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() }],
});
useFlowStore.setState({ nodes: [], edges: [] });
useCanvasStore.setState({
  activeCanvasId: ACTIVE,
  canvases: [
    { id: ACTIVE, name: "active", nodes: [], edges: [] },
    { id: OTHER, name: "other", nodes: [{ id: NODE2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }], edges: [] },
  ],
});
timeline.push(`${at()} [夹具完成] 前置副本.queued=${JSON.stringify(readOther())} jobs=${JSON.stringify(useQueueStore.getState().jobs.map((j) => j.status))} hasHydrated=${useQueueStore.persist.hasHydrated()}`);

await nodeExecutor.executeNode({ id: NODE2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }, OTHER);
timeline.push(`${at()} [执行器返回] 副本.queued=${JSON.stringify(readOther())}`);
await new Promise((r) => setTimeout(r, 900));
timeline.push(`${at()} [等 900ms 后] 副本.queued=${JSON.stringify(readOther())} jobs=${JSON.stringify(useQueueStore.getState().jobs.map((j) => j.status))} hasHydrated=${useQueueStore.persist.hasHydrated()}`);

console.log("=".repeat(78));
for (const line of timeline) console.log(line);
console.log("=".repeat(78));
console.log(`最终副本.queued = ${JSON.stringify(readOther())}`);
