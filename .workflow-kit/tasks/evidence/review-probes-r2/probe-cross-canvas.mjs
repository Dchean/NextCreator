/**
 * 独立审查探针 9（TASK-006 / REQ-002）—— 跨画布同名 nodeId
 *
 * 事实：canvasStore.duplicateCanvas（canvasStore.ts:105-125）用 `{...canvas}` 复制画布，
 * **node.id 原样保留** → 两个画布上存在同 id 的节点。Sidebar.tsx:145 的"复制画布"与
 * Sidebar.tsx:299 的 switchCanvas 都是真实 UI 入口。
 *
 * 但新守卫只按 nodeId 判定（queueStore.ts:106-108），忽略 job.canvasId；
 * batchChains 也只按 nodeId 建键（queueStore.ts:237）。本探针用**真实 hook**驱动，
 * 在画布 X / 画布 Y 之间切换 activeCanvasId 后各点一次生成，观察是否互相干扰。
 *
 * 用法：node --experimental-strip-types probe-cross-canvas.mjs
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

// 执行器：慢速成功，保持"活动"窗口（不写 queued，便于观察判定本身）；getImageBatchCount 忠实实现
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec-slowok", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec-slowok") {
      return {
        format: "module",
        source: `export const executeImageGeneration = async (nodeId) => {
                   await new Promise((r) => setTimeout(r, 1200));
                   return { success: true, cancelled: false };
                 };
                 export const getImageBatchCount = (data) => (data?.apiProtocol === "openai-images" ? 1 : Math.min(Math.max(data?.n || 1, 1), 4));`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { createRequire } = await import("node:module");
const requireRepo = createRequire(path.join(REPO, "package.json"));
const React = requireRepo("react");
const { renderToStaticMarkup } = requireRepo("react-dom/server");

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { useImageGeneratorExecution } = await import(
  pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href
);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

// 模拟 Sidebar 的"复制画布"：node.id 完全相同
const X = "canvas-x";
const Y = "canvas-y";
const NID = "shared-node-id";
const mkNode = () => ({
  id: NID,
  type: "imageGeneratorNode",
  position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "cross canvas", n: Number(process.argv[2] ?? 2) },
});
useCanvasStore.setState({
  canvases: [
    { id: X, name: "A", createdAt: 1, updatedAt: 1, edges: [], nodes: [mkNode()] },
    { id: Y, name: "A (副本)", createdAt: 1, updatedAt: 1, edges: [], nodes: [mkNode()] },
  ],
  activeCanvasId: X,
  _hasHydrated: true,
});
useQueueStore.setState({ jobs: [], paused: false, concurrency: 4 });

let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution(NID, useFlowStore.getState().nodes[0]?.data ?? {});
  handle = handleGenerate;
  return null;
}

const jobsFor = (canvasId) => useQueueStore.getState().jobs.filter((j) => j.canvasId === canvasId).length;

// —— 画布 X：点一次生成（批量 n=2 → 应入队 2 个）——
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
renderToStaticMarkup(React.createElement(Probe));
await handle();
const afterX = jobsFor(X);

// —— 切到画布 Y（同一 node.id），点一次生成 ——
useCanvasStore.setState({ activeCanvasId: Y });
useFlowStore.setState({ nodes: [mkNode()], edges: [] }); // App.tsx:154 setNodes 的等价物
await handle();
const afterY = jobsFor(Y);

console.log("== 跨画布同名 nodeId（复制画布后）==");
console.log(`画布 X 点击一次（批量 n=2）→ X 上的 job 数 = ${afterX}（期望 2）`);
console.log(`切到画布 Y 点击一次（批量 n=2）→ Y 上的 job 数 = ${afterY}（期望 2）`);
console.log(`队列总计 = ${useQueueStore.getState().jobs.length}`);
console.log("");
if (afterX === 2 && afterY === 2) {
  console.log("RESULT: 两画布互不干扰。");
} else {
  console.log("RESULT: **画布 Y 的合法生成被拒绝**（Y 上的节点在 UI 上可点、按钮可用），");
  console.log("        原因是守卫只按 nodeId 判定、忽略 canvasId —— 同名节点被当成同一个节点。");
  console.log("        叠加 hook 忽略 enqueue 返回值的行为，Y 的节点会被标记为永久“排队中”。");
}
process.exitCode = 0;
