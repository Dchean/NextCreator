/**
 * 独立审查探针 2（TASK-006 / REQ-001）
 *
 * 目的：忠实复现**真实冷启动顺序**下恢复逻辑与 React 挂载的竞态。
 *
 * 真实顺序（依据源码）：
 *   1. 模块求值（同一 tick）：canvasStore（persist 水合开始）→ queueStore（persist 水合开始）
 *      —— queueStore 由 Toolbar.tsx:6 import，flowStore(Toolbar:4) 内部 import canvasStore，
 *      所以 canvasStore 的 getItem 先发起。
 *   2. canvasStore 水合完成 → _hasHydrated=true，canvases/activeCanvasId 就绪。
 *   3. App.tsx:121-163 的 useEffect（依赖 activeCanvasId）在 React 渲染提交后执行 setNodes(nodes)，
 *      此时 flowStore.nodes 才第一次被填上（flowStore **不持久化**，冷启动时是空的）。
 *   4. queueStore 的 onRehydrateStorage → recoverPersistedQueuedJobs → waitForCanvasReady 轮询
 *      （判定条件：`_hasHydrated || 每个 job 的节点都可解析`）。
 *
 * 本探针把"App 的 setNodes"建模为 canvasStore 水合后延迟 D 毫秒执行，扫描 D，
 * 观察：恢复是否清掉了残留 queued 标记、恢复是否真的把任务执行了。
 *
 * 用法：node --experimental-strip-types probe-req001-race.mjs [delayMs ...]
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
  for (const c of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) {
    if (existsSync(c)) return c;
  }
  return p;
}

// 记录执行器是否真的被调用、传入的 nodeId/canvasId、以及返回结果（用于区分"恢复执行"与"节点不存在"）
const EXEC_LOG = [];
const EXEC_MUTANT = `mutant:exec-observe`;

registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    // 只替换执行器，其余保持真实；把调用记到 globalThis 供本探针读取
    if (spec === "@/services/imageGenerationExecution") return { url: EXEC_MUTANT, shortCircuit: true };
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
    if (url === EXEC_MUTANT) {
      return {
        format: "module",
        source: `export const executeImageGeneration = async (nodeId, options) => {
                   const { useFlowStore } = await import("@/stores/flowStore");
                   const { useCanvasStore } = await import("@/stores/canvasStore");
                   const { activeCanvasId } = useCanvasStore.getState();
                   const inFlow = useFlowStore.getState().nodes.some((n) => n.id === nodeId);
                   const canvas = options?.canvasId ? useCanvasStore.getState().canvases.find((c) => c.id === options.canvasId) : null;
                   const inCanvas = Boolean(canvas && canvas.nodes.some((n) => n.id === nodeId));
                   // 复刻真实执行器 readNodeFromCanvas 的判定（imageGenerationExecution.ts:92-99）
                   const visible = !options?.canvasId || options.canvasId === activeCanvasId ? inFlow : inCanvas;
                   globalThis.__NC_EXEC_LOG__.push({ nodeId, canvasId: options?.canvasId ?? null, inFlow, inCanvas, visible });
                   if (!visible) return { success: false, error: "节点不存在" };
                   return { success: true, cancelled: false };
                 };
                 export const getImageBatchCount = (data) => (data?.apiProtocol === "openai-images" ? 1 : Math.min(Math.max(data?.n || 1, 1), 4));`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

globalThis.__NC_EXEC_LOG__ = EXEC_LOG;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANVAS_ID = "canvas-1";
const NODE_ID = "node-1";
const JOB_ID = "job-persisted-queued";

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

async function runDelayed(delayMs) {
  // 每个 delay 需要独立的模块图 → 用子进程不行（本文件复用），这里改为直接跑一次并在外部多次调用
  const { useCanvasStore } = await importRepo("stores/canvasStore.ts");
  const { useFlowStore } = await importRepo("stores/flowStore.ts");

  // 模拟 App.tsx:121-163：canvasStore 一动就延迟 delayMs 把活动画布节点灌进 flowStore
  let appLoaded = false;
  const unsub = useCanvasStore.subscribe((state) => {
    if (!appLoaded && state.activeCanvasId) {
      appLoaded = true;
      setTimeout(() => {
        const canvas = useCanvasStore.getState().getActiveCanvas();
        if (canvas) useFlowStore.getState().setNodes(canvas.nodes);
      }, delayMs);
    }
  });

  const { useQueueStore } = await importRepo("stores/queueStore.ts");
  await sleep(2000);

  const job = useQueueStore.getState().jobs.find((j) => j.id === JOB_ID);
  const canvasFlag = useCanvasStore.getState().canvases[0].nodes[0].data.queued;
  const flowFlag = useFlowStore.getState().nodes.find((n) => n.id === NODE_ID)?.data?.queued;
  const exec = EXEC_LOG[0] ?? null;
  unsub();

  return {
    delayMs,
    jobStatus: job ? job.status : "(消失)",
    jobError: job?.error ?? "-",
    canvasQueued: canvasFlag,
    flowQueued: flowFlag,
    execVisible: exec ? exec.visible : "(执行器未被调用)",
    nodeLocked: flowFlag === true,
  };
}

const delays = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
const list = delays.length ? delays : [0];

console.log("delay(ms) | job.status   | job.error        | canvas.queued | flow.queued | 执行器看到的节点 | 结论");
console.log("-".repeat(118));
for (const d of list) {
  const r = await runDelayed(d);
  console.log(
    `${String(r.delayMs).padEnd(9)} | ${r.jobStatus.padEnd(12)} | ${String(r.jobError).padEnd(16)} | ` +
      `${String(r.canvasQueued).padEnd(13)} | ${String(r.flowQueued).padEnd(11)} | ${String(r.execVisible).padEnd(16)} | ` +
      (r.nodeLocked ? "节点锁死（排队中）" : "节点可用")
  );
  // 每个 delay 需要全新模块状态；同一进程里 store 已定型，所以只支持单次运行
  if (list.length > 1) break;
}
