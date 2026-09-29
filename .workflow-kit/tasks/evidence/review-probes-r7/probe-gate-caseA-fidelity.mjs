/**
 * 独立审查探针 10（TASK-006 / REQ-001）—— 门禁用例 A 的忠实度检验
 *
 * 门禁用例 A（scripts/queue-regression.mjs:353-469）的种子与前置：
 *   · 队列里 1 个 queued job，**canvasId: null**（第 366 行）
 *   · 在 import queueStore **之前** useFlowStore.setState({nodes:[该节点], data.queued:true})（第 388-398 行）
 *   · 断言读 **useFlowStore**（第 414-415 行）
 *
 * 本探针逐项复刻门禁用例 A（含这两个前置），然后**追加**真实 App 的两条数据流：
 *   ① App.tsx:121-163：canvasStore 就绪后 setNodes(画布节点) → flowStore
 *      （flowStore 不持久化；重启后 UI 上的节点数据只能来自 canvasStore）
 *   ② App.tsx:167-186：flowStore 变化后 800ms 防抖回写 canvasStore
 * 观察节点最终的 data.queued（ImageGeneratorNode.tsx:215 canRun 依赖它）。
 *
 * canvasStore 里该节点 data.queued=true 是重启前点"生成"时写下的（useImageGeneratorExecution.ts:86-90），
 * 经 ② 的同步路径落盘 —— 与队列记录同一次会话写入磁盘。
 *
 * 用法：node --experimental-strip-types probe-gate-caseA-fidelity.mjs
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
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NODE_ID = "regression-node-1";   // 与门禁用例 A 相同的 id
const JOB_ID = "regression-stale-queued-1";
const CANVAS_ID = "canvas-1";

// 门禁用例 A 的队列种子（逐字复刻：canvasId: null）
globalThis.__NC_STORE_SEED__["generation-queue"] = JSON.stringify({
  state: {
    jobs: [
      { id: JOB_ID, nodeId: NODE_ID, canvasId: null, nodeLabel: "回归用例A", modelLabel: "regression-model",
        promptPreview: "persisted queued job before restart", status: "queued", createdAt: 1 },
    ],
    concurrency: 2,
  },
  version: 0,
});
// 真实重启时 canvasStore 里也有一份（节点 data.queued=true 由点生成时写下并落盘）
globalThis.__NC_STORE_SEED__["next-creator-canvases"] = JSON.stringify({
  state: {
    canvases: [
      { id: CANVAS_ID, name: "默认画布", createdAt: 1, updatedAt: 1, edges: [],
        nodes: [{ id: NODE_ID, type: "imageGeneratorNode", position: { x: 0, y: 0 },
                  data: { label: "绘图生成", prompt: "queued before restart", queued: true, n: 1 } }] },
    ],
    activeCanvasId: CANVAS_ID,
  },
  version: 0,
});

const importRepo = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);
const { useCanvasStore } = await importRepo("stores/canvasStore.ts");
const { useFlowStore } = await importRepo("stores/flowStore.ts");
const { getDefaultImageGeneratorData } = await importRepo("components/nodes/imageGeneratorConfig.ts");

// —— 门禁用例 A 的前置：import queueStore 之前就把节点放进 flowStore（第 388-398 行）——
useFlowStore.setState({
  nodes: [
    { id: NODE_ID, type: "imageGeneratorNode", position: { x: 0, y: 0 },
      data: { ...getDefaultImageGeneratorData(), prompt: "queued before restart", queued: true } },
  ],
  edges: [],
});
console.log("前置（与门禁用例 A 相同）：flowStore 已含该节点且 data.queued=true；队列种子 canvasId=null");

// —— queueStore 水合 → 恢复（门禁断言的就是这一段）——
const { useQueueStore } = await importRepo("stores/queueStore.ts");
const hydrated = await (async () => {
  const deadline = Date.now() + 3000;
  while (!useQueueStore.persist.hasHydrated() && Date.now() < deadline) await sleep(25);
  return useQueueStore.persist.hasHydrated();
})();
await sleep(1500);

const jobAfter = useQueueStore.getState().jobs.find((j) => j.id === JOB_ID);
const flowFlagGate = useFlowStore.getState().nodes.find((n) => n.id === NODE_ID)?.data?.queued;
const canvasFlagGate = useCanvasStore.getState().canvases[0]?.nodes[0]?.data?.queued;
console.log("");
console.log("=== 门禁断言的那一刻（只跑到这里，门禁判 PASS）===");
console.log(`  水合完成=${hydrated}`);
console.log(`  job.status=${jobAfter?.status ?? "(消失)"}`);
console.log(`  flowStore   data.queued=${JSON.stringify(flowFlagGate)}   ← 门禁断言的就是它（第 414-415 行）`);
console.log(`  canvasStore data.queued=${JSON.stringify(canvasFlagGate)}   ← 门禁从未检查这一份`);

// —— 追加真实 App 的数据流 ——
// ① App.tsx:121-163：画布加载完成后把 canvasStore 的节点灌进 flowStore
console.log("");
console.log("=== 追加 App.tsx:121-163（activeCanvasId 就绪 → setNodes(画布节点)）===");
const canvasNode = useCanvasStore.getState().canvases[0].nodes[0];
useFlowStore.getState().setNodes([canvasNode]);
useFlowStore.getState().setEdges([]);
const flowFlagAfterLoad = useFlowStore.getState().nodes.find((n) => n.id === NODE_ID)?.data?.queued;
console.log(`  setNodes 之后 flowStore data.queued=${JSON.stringify(flowFlagAfterLoad)}  ← 覆盖了恢复清掉的值`);

// ② App.tsx:167-186：800ms 防抖回写画布（维持落盘状态）
const { nodes, edges } = useFlowStore.getState();
useCanvasStore.getState().updateCanvasData(nodes, edges);
const canvasFlagFinal = useCanvasStore.getState().canvases[0]?.nodes[0]?.data?.queued;

const flowNode = useFlowStore.getState().nodes.find((n) => n.id === NODE_ID);
const canRun = Boolean(flowNode?.data?.prompt) && flowNode?.data?.status !== "loading" && !(flowFlagAfterLoad === true);

console.log("");
console.log("================ 用户最终看到的状态 ================");
console.log(`  flowStore   data.queued = ${JSON.stringify(flowFlagAfterLoad)}`);
console.log(`  canvasStore data.queued = ${JSON.stringify(canvasFlagFinal)}（落盘，重启后再次载入）`);
console.log(`  ImageGeneratorNode.canRun = ${canRun}`);
console.log("");
console.log(
  canRun === false
    ? "RESULT: 门禁用例 A 判 PASS 的同时，用户在真实 App 里看到的仍是“排队中”+按钮禁用。\n" +
        "        根因：恢复只清了 flowStore 这一份（且只在 flowStore 已有该节点时才有意义），\n" +
        "        canvasStore 里落盘的那一份没清，随后被 App.setNodes 重新灌回 flowStore。"
    : "RESULT: 节点可用。"
);
