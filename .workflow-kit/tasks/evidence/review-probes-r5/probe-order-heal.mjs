/**
 * 独立审查探针 12（TASK-006 / REQ-001）—— 反序检验（诚实性检验）
 *
 * 问题：REQ-001 的结论是否依赖"恢复派发"与"App 载入节点"的先后？
 *   · 顺序 A（真实冷启动）：canvasStore 先水合 → 恢复清 flowStore（此时为空，无效）
 *       + canvasStore 分支因 canvasId===activeCanvasId 直接 return（queueStore.ts:433）
 *       → 派发时 flowStore 里没有该节点 → 执行器返回"节点不存在"，且画布上 queued=true 被
 *         App.setNodes 灌回 flowStore → 节点锁死。
 *   · 顺序 B（假设 App 的 setNodes 先于恢复的清理）：恢复清掉 flowStore 的标记 →
 *       App.tsx:167-186 的 800ms 防抖把它回写画布 → 画布也被清 → 节点可用。
 *
 * 本探针显式构造顺序 B（把节点预先放进 flowStore，再 import queueStore），
 * 并在恢复之后执行真实的防抖回写，检验 B 是否确实能自愈。
 * 若 B 能自愈，则说明该缺陷是**时序相关**的，而不是绝对不可恢复。
 *
 * 用法：node --experimental-strip-types probe-order-heal.mjs
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
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec-faithful3", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec-faithful3") {
      return {
        format: "module",
        source: `export const executeImageGeneration = async (nodeId, options) => {
                   const { useFlowStore } = await import("@/stores/flowStore");
                   const { useCanvasStore } = await import("@/stores/canvasStore");
                   const { activeCanvasId } = useCanvasStore.getState();
                   const inFlow = useFlowStore.getState().nodes.some((n) => n.id === nodeId);
                   const inCanvas = Boolean(options?.canvasId && useCanvasStore.getState().canvases
                     .find((c) => c.id === options.canvasId)?.nodes.some((n) => n.id === nodeId));
                   const visible = !options?.canvasId || options.canvasId === activeCanvasId ? inFlow : inCanvas;
                   globalThis.__NC_EXEC__ = visible ? "运行（写 queued:false）" : "节点不存在（不写 queued）";
                   if (!visible) return { success: false, error: "节点不存在" };
                   useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false });
                   await new Promise((r) => setTimeout(r, 100));
                   useFlowStore.getState().updateNodeData(nodeId, { status: "success" });
                   return { success: true, cancelled: false };
                 };
                 export const getImageBatchCount = () => 1;`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANVAS_ID = "canvas-1";
const NODE_ID = "node-1";
const JOB_ID = "job-left";

globalThis.__NC_STORE_SEED__["generation-queue"] = JSON.stringify({
  state: {
    jobs: [{ id: JOB_ID, nodeId: NODE_ID, canvasId: CANVAS_ID, nodeLabel: "L", modelLabel: "M",
             promptPreview: "P", status: "queued", createdAt: 1 }],
    concurrency: 2,
  },
  version: 0,
});
globalThis.__NC_STORE_SEED__["next-creator-canvases"] = JSON.stringify({
  state: {
    canvases: [{ id: CANVAS_ID, name: "默认画布", createdAt: 1, updatedAt: 1, edges: [],
                 nodes: [{ id: NODE_ID, type: "imageGeneratorNode", position: { x: 0, y: 0 },
                           data: { label: "绘图生成", prompt: "hello", queued: true, n: 1 } }] }],
    activeCanvasId: CANVAS_ID,
  },
  version: 0,
});

const importRepo = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);
const { useCanvasStore } = await importRepo("stores/canvasStore.ts");
const { useFlowStore } = await importRepo("stores/flowStore.ts");
const { getDefaultImageGeneratorData } = await importRepo("components/nodes/imageGeneratorConfig.ts");

// —— 构造顺序 B：在 import queueStore 之前，flowStore 里**已经**有该节点（模拟 App 先加载完）——
useFlowStore.setState({
  nodes: [{ id: NODE_ID, type: "imageGeneratorNode", position: { x: 0, y: 0 },
            data: { ...getDefaultImageGeneratorData(), prompt: "hello", queued: true } }],
  edges: [],
});
// App.tsx:167-186 的防抖回写（flowStore 一变 → 800ms 后写画布）
let timer = null;
useFlowStore.subscribe((state, prev) => {
  if (state.nodes === prev.nodes) return;
  if (!useCanvasStore.getState().activeCanvasId) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const { nodes, edges } = useFlowStore.getState();
    useCanvasStore.getState().updateCanvasData(nodes, edges);
  }, 800);
});

console.log("顺序 B：import queueStore 之前 flowStore 已有该节点（data.queued=true）");
const { useQueueStore } = await importRepo("stores/queueStore.ts");
await sleep(2500);

const flowQ = useFlowStore.getState().nodes.find((n) => n.id === NODE_ID)?.data?.queued;
const canvasQ = useCanvasStore.getState().canvases[0]?.nodes[0]?.data?.queued;
const job = useQueueStore.getState().jobs.find((j) => j.id === JOB_ID);
const node = useFlowStore.getState().nodes.find((n) => n.id === NODE_ID);
const canRun = Boolean(node?.data?.prompt) && node?.data?.status !== "loading" && !(flowQ === true);

console.log("");
console.log(`执行器判定：${globalThis.__NC_EXEC__}`);
console.log(`job.status=${job?.status ?? "(消失)"}${job?.error ? `  error="${job.error}"` : ""}`);
console.log(`flowStore   data.queued=${JSON.stringify(flowQ)}`);
console.log(`canvasStore data.queued=${JSON.stringify(canvasQ)}`);
console.log(`ImageGeneratorNode.canRun=${canRun}`);
console.log("");
console.log(
  canRun === true
    ? "结论：顺序 B 下可自愈（恢复先清 flowStore，App 的防抖再把画布同步干净）。\n" +
      "      → 该缺陷是**时序相关**：冷启动的真实顺序（canvasStore 先水合、恢复先派发）落在锁死分支。"
    : "结论：顺序 B 下仍锁死。"
);
