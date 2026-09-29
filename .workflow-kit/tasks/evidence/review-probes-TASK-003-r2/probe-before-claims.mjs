/**
 * 验证两件事：
 *  (1) 上面"非活动画布标记被清"的真因是否 = 探针夹具与 queueStore **异步水合** 竞态
 *      （而非 TASK-003 引入的产品缺陷）。判据：同一夹具在 **before 树**（改动前的 src）
 *      上是否同样被清。若同样被清，则与本次改动无关。
 *  (2) nodeExecutor 注释里两条"差异"断言在 before 树上是否真的成立：
 *      · 缺少提示词时错误文案为「缺少必需的提示词输入」（candidate 为「请连接提示词节点」）
 *      · provider 成功但未返回图片数据时，before 会写 status:"success"（假成功）
 *
 * 运行：NC_ROOT=<树> NC_LABEL=<标签> node --experimental-strip-types probe-before-claims.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = process.env.NC_ROOT ? path.resolve(process.env.NC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");
const LABEL = process.env.NC_LABEL || "(unlabeled)";
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
    // 真实 fileStorageService，但 invoke 被 stub 抛错 → saveImage 失败 → 走 base64 回退
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
        export const generateImage = async () => globalThis.__NC_EMPTY__
          ? { text: "no image returned" }
          : { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="], text: "t" };
        export const editImage = generateImage; export default {};` };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const { nodeExecutor } = await import(pathToFileURL(path.join(SRC, "services/nodeExecutor.ts")).href);

const ACTIVE = "cl-active", OTHER = "cl-other", N2 = "cl-node2";
const data = (extra = {}) => ({ ...getDefaultImageGeneratorData(), prompt: "p", ...extra });
const readOther = () => {
  const c = useCanvasStore.getState().canvases.find((x) => x.id === OTHER);
  const n = c && c.nodes.find((x) => x.id === N2);
  return n ? n.data.queued : "NO_NODE";
};

console.log("=".repeat(78));
console.log(`LABEL=${LABEL}`);
console.log("=".repeat(78));

// ---------- (1) 同一夹具（晚 import 后立刻塞 job）在 before 树上是否同样清标记 ----------
{
  useQueueStore.setState({
    paused: true, concurrency: 1,
    jobs: [{ id: "cl-job", nodeId: N2, canvasId: OTHER, nodeLabel: "O", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() }],
  });
  useFlowStore.setState({ nodes: [], edges: [] });
  useCanvasStore.setState({
    activeCanvasId: ACTIVE,
    canvases: [
      { id: ACTIVE, name: "a", nodes: [], edges: [] },
      { id: OTHER, name: "o", nodes: [{ id: N2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data({ queued: true }) }], edges: [] },
    ],
  });
  const pre = readOther();
  globalThis.__NC_EMPTY__ = false;
  await nodeExecutor.executeNode({ id: N2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data({ queued: true }) }, OTHER);
  await new Promise((r) => setTimeout(r, 900));
  console.log(`(1) 晚 import + 立刻塞 job → 前置=${JSON.stringify(pre)} 后置=${JSON.stringify(readOther())}（若同为 false，说明该清除与 TASK-003 无关）`);
  useQueueStore.setState({ jobs: [] });
}

// ---------- (2) 缺少提示词：错误文案 ----------
{
  const N = "cl-noprompt", C = "cl-c";
  useFlowStore.setState({ nodes: [{ id: N, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data({ prompt: "" }) }], edges: [] });
  useCanvasStore.setState({ activeCanvasId: C, canvases: [{ id: C, name: "c", nodes: [{ id: N, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data({ prompt: "" }) }], edges: [] }] });
  const res = await nodeExecutor.executeNode(useFlowStore.getState().nodes.find((n) => n.id === N), C);
  const d = useFlowStore.getState().nodes.find((n) => n.id === N).data;
  console.log(`(2) 缺少提示词 → 返回 error=${JSON.stringify(res.error)} / 节点 status=${JSON.stringify(d.status)} error=${JSON.stringify(d.error)}`);
}

// ---------- (3) provider 成功但无图片数据 ----------
{
  const N = "cl-empty", C = "cl-c2";
  useFlowStore.setState({ nodes: [{ id: N, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }], edges: [] });
  useCanvasStore.setState({ activeCanvasId: C, canvases: [{ id: C, name: "c2", nodes: [{ id: N, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }], edges: [] }] });
  globalThis.__NC_EMPTY__ = true;
  const res = await nodeExecutor.executeNode(useFlowStore.getState().nodes.find((n) => n.id === N), C);
  const d = useFlowStore.getState().nodes.find((n) => n.id === N).data;
  console.log(`(3) provider 成功但无图片数据 → 返回 success=${res.success} error=${JSON.stringify(res.error)} / 节点 status=${JSON.stringify(d.status)}（假成功？）`);
  globalThis.__NC_EMPTY__ = false;
}
console.log("DONE");
