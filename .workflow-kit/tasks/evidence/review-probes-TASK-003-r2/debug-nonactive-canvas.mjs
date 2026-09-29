/**
 * 定位：非活动画布场景下，canvasStore 副本的 queued 标记被谁写成 false。
 * 做法：包住 flowStore.updateNodeData / flowStore.setState / canvasStore.setState，
 * 一旦目标 node 的 queued 从 true 变 falsy，立即打印调用栈。
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
        export const generateImage = async () => fake; export const editImage = async () => fake; export default {};` };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const { nodeExecutor } = await import(pathToFileURL(path.join(SRC, "services/nodeExecutor.ts")).href);

const OTHER = "dbg-other";
const ACTIVE = "dbg-active";
const NODE2 = "dbg-node2";
const data = () => ({ ...getDefaultImageGeneratorData(), prompt: "p", queued: true });

const readOther = () => {
  const c = useCanvasStore.getState().canvases.find((x) => x.id === OTHER);
  const n = c && c.nodes.find((x) => x.id === NODE2);
  return n ? n.data.queued : "NO_NODE";
};

// ---- 插桩：包住三个写入入口 ----
let armed = false;
function trace(label) {
  if (!armed) return;
  if (readOther() === false || readOther() === undefined) {
    console.log(`\n>>> 标记变 falsy 于: ${label}`);
    console.log(new Error("stack").stack.split("\n").slice(1, 12).join("\n"));
    armed = false;
  }
}
const cset = useCanvasStore.setState.bind(useCanvasStore);
useCanvasStore.setState = (...a) => { const r = cset(...a); trace("canvasStore.setState"); return r; };
const fset = useFlowStore.setState.bind(useFlowStore);
useFlowStore.setState = (...a) => { const r = fset(...a); trace("flowStore.setState"); return r; };
const fupd = useFlowStore.getState().updateNodeData;
useFlowStore.setState({ updateNodeData: (...a) => { const r = fupd(...a); trace("flowStore.updateNodeData"); return r; } });

// ---- 夹具：先建活动任务，再写节点数据（避免自愈把标记当陈旧清掉）----
useQueueStore.setState({
  paused: true, concurrency: 1,
  jobs: [{ id: "dbg-job", nodeId: NODE2, canvasId: OTHER, nodeLabel: "O", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() }],
});
useFlowStore.setState({ nodes: [], edges: [] });
useCanvasStore.setState({
  activeCanvasId: ACTIVE,
  canvases: [
    { id: ACTIVE, name: "active", nodes: [], edges: [] },
    { id: OTHER, name: "other", nodes: [{ id: NODE2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }], edges: [] },
  ],
});
console.log("前置 canvas副本.queued =", JSON.stringify(readOther()));
armed = true;

await nodeExecutor.executeNode({ id: NODE2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }, OTHER);
await new Promise((r) => setTimeout(r, 80));
armed = false;
console.log("后置 canvas副本.queued =", JSON.stringify(readOther()));

// 对照：完全不跑执行器，只做同样的夹具 + 一拍等待
armed = false;
useQueueStore.setState({ jobs: [] });
useFlowStore.setState({ nodes: [], edges: [] });
useCanvasStore.setState({ activeCanvasId: ACTIVE, canvases: [] });
await new Promise((r) => setTimeout(r, 50));
useQueueStore.setState({
  paused: true, concurrency: 1,
  jobs: [{ id: "dbg-job2", nodeId: NODE2, canvasId: OTHER, nodeLabel: "O", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() }],
});
useFlowStore.setState({ nodes: [], edges: [] });
useCanvasStore.setState({
  activeCanvasId: ACTIVE,
  canvases: [
    { id: ACTIVE, name: "active", nodes: [], edges: [] },
    { id: OTHER, name: "other", nodes: [{ id: NODE2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }], edges: [] },
  ],
});
console.log("对照（不跑执行器）写后 canvas副本.queued =", JSON.stringify(readOther()));
await new Promise((r) => setTimeout(r, 80));
console.log("对照（不跑执行器）等待后 =", JSON.stringify(readOther()));
