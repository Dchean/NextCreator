/**
 * 独立审查探针 7（TASK-006 / REQ-001）—— 判定性探针
 *
 * 忠实复现真实重启后的顺序与数据流：
 *   1. 模块求值：canvasStore（persist 水合开始，先，因为 flowStore.ts:20 依赖它）
 *                → flowStore（**不持久化**，nodes 冷启动为空）
 *                → queueStore（由 Toolbar.tsx:6 引入，persist 水合开始）
 *   2. canvasStore 水合完成 → _hasHydrated=true、activeCanvasId 就绪
 *   3. App.tsx:121-163 的 useEffect（React 提交后才跑，属宏任务）→ setNodes(活动画布的节点)
 *   4. App.tsx:167-186 的 subscribe：flowStore.nodes 一变，**防抖 800ms** 后
 *      useCanvasStore.updateCanvasData(flowStore.nodes) → 写回画布（进而落盘）
 *   5. queueStore 的 onRehydrateStorage → recoverPersistedQueuedJobs()
 *      → updateNodeQueuedState(nodeId, canvasId, false)
 *        · flowStore 分支：总是写（但此刻可能还没有该节点）
 *        · canvasStore 分支：`if (canvasId === activeCanvasId) return;` ← 活动画布直接跳过
 *      → waitForCanvasReady：`_hasHydrated || 全部可解析` —— canvasStore 已水合即**立即放行**
 *      → pump() → executeImageGeneration → readNodeFromCanvas：
 *          画布是活动的 → 读 **flowStore**（imageGenerationExecution.ts:94-95）
 *
 * 判据（用户可见）：App 加载完画布后，节点的 data.queued 是否仍为 true
 * （ImageGeneratorNode.tsx:215 canRun = ... && !isQueued）。
 *
 * 用法：node --experimental-strip-types probe-restart-final.mjs <appLoadDelayMs>
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const APP_LOAD_DELAY = Number(process.argv[2] ?? 0);

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

// 只观察，不替换执行器之外的东西
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
const CANVAS_ID = "canvas-1";
const NODE_ID = "node-1";
const JOB_ID = "job-left-queued";

globalThis.__NC_STORE_SEED__["next-creator-canvases"] = JSON.stringify({
  state: {
    canvases: [
      {
        id: CANVAS_ID,
        name: "默认画布",
        createdAt: 1,
        updatedAt: 1,
        edges: [],
        nodes: [
          {
            id: NODE_ID,
            type: "imageGeneratorNode",
            position: { x: 0, y: 0 },
            // 重启前点"生成"时由 useImageGeneratorExecution.ts:86-90 写下，经 App 的防抖同步落盘
            data: { label: "绘图生成", prompt: "hello", queued: true, n: 1 },
          },
        ],
      },
    ],
    activeCanvasId: CANVAS_ID,
  },
  version: 0,
});

globalThis.__NC_STORE_SEED__["generation-queue"] = JSON.stringify({
  state: {
    jobs: [
      {
        id: JOB_ID,
        nodeId: NODE_ID,
        canvasId: CANVAS_ID,
        nodeLabel: "绘图生成",
        modelLabel: "m",
        promptPreview: "hello",
        status: "queued",
        createdAt: 1,
      },
    ],
    concurrency: 2,
  },
  version: 0,
});

const importRepo = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

// —— 1. 模块求值：canvasStore 先（真实顺序见 flowStore.ts:20 对 canvasStore 的依赖）——
const { useCanvasStore } = await importRepo("stores/canvasStore.ts");
const { useFlowStore } = await importRepo("stores/flowStore.ts");

// —— 4. App.tsx:167-186 的防抖同步（flowStore → canvasStore）——
{
  let timer = null;
  useFlowStore.subscribe((state, prev) => {
    if (state.nodes === prev.nodes && state.edges === prev.edges) return;
    if (!useCanvasStore.getState().activeCanvasId) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const { nodes, edges } = useFlowStore.getState();
      useCanvasStore.getState().updateCanvasData(nodes, edges);
    }, 800);
  });
}

// —— 3. App.tsx:121-163：activeCanvasId 就绪后（React effect）把画布节点灌进 flowStore ——
let appLoaded = false;
useCanvasStore.subscribe((state) => {
  if (appLoaded || !state.activeCanvasId) return;
  appLoaded = true;
  setTimeout(() => {
    const canvas = useCanvasStore.getState().getActiveCanvas();
    if (canvas) {
      console.log(`[t≈${APP_LOAD_DELAY}ms] App 的 setNodes：把活动画布的 ${canvas.nodes.length} 个节点灌进 flowStore`);
      useFlowStore.getState().setNodes(canvas.nodes);
      useFlowStore.getState().setEdges(canvas.edges);
    }
  }, APP_LOAD_DELAY);
});

console.log(`== 模拟重启（App 加载画布的延迟 = ${APP_LOAD_DELAY}ms）==`);

// —— 2/5. queueStore 水合 + 恢复 ——
const { useQueueStore } = await importRepo("stores/queueStore.ts");

await sleep(300);
console.log(`[t≈300ms] flowStore.nodes=${useFlowStore.getState().nodes.length}（App 是否已加载：${appLoaded ? "是" : "否"}）`);

await sleep(3000); // 等 pump、执行器、以及 800ms 防抖同步全部走完

const job = useQueueStore.getState().jobs.find((j) => j.id === JOB_ID);
const canvasFlag = useCanvasStore.getState().canvases[0].nodes[0].data.queued;
const flowNode = useFlowStore.getState().nodes.find((n) => n.id === NODE_ID);
const flowFlag = flowNode?.data?.queued;
const canRun = flowNode ? Boolean(flowNode.data.prompt) && flowNode.data.status !== "loading" && !(flowFlag === true) : "(节点未加载)";

console.log("");
console.log("================ 最终状态（所有异步流程已结束）================");
console.log(`队列里的遗留 job：status=${job ? job.status : "(消失)"}${job?.error ? `，error="${job.error}"` : ""}`);
console.log(`flowStore  该节点 data.queued = ${JSON.stringify(flowFlag)}   ← ImageGeneratorNode 读的是这一份`);
console.log(`canvasStore 该节点 data.queued = ${JSON.stringify(canvasFlag)}  ← 落盘的那一份`);
console.log(`ImageGeneratorNode.canRun（ImageGeneratorNode.tsx:215）= ${canRun}`);
console.log("");
if (canRun === false && flowFlag === true) {
  console.log("RESULT: **节点仍被锁死**（显示“排队中”、生成按钮永久禁用）—— REQ-001 的用户可见症状仍在。");
} else if (canRun === true) {
  console.log("RESULT: 节点可用（此顺序下 REQ-001 达标）。");
} else {
  console.log(`RESULT: ${canRun}`);
}
