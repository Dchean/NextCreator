/**
 * 独立审查探针 R6-A（round 6, F-R5-1）：在**正常（未暂停）**批量窗口里复现"按钮可点但点击必被拒"，
 * 独立检查本轮新增的 toast 反馈通道与"被拒点击零副作用"。
 *
 * 与 worker 的 probe-r5fix1-feedback.mjs 无关：断言、夹具、执行器桩全部自建。
 *
 * 断言：
 *   ① toast.info 在本环境可导入、是函数（toastStore 只有 zustand 依赖，无环/无 DOM）；
 *   ② hook 返回形状未变（UI/测试契约不变）；
 *   ③ 正常窗口真实可达：n=4、concurrency=1、**未暂停**，1 张跑完后 canRun 谓词为 true；
 *   ④ 被接受的（首次）点击不产生提示（无误报）；
 *   ⑤ 被拒点击逐个给提示（6 次点击 → 6 条，无去重）；
 *   ⑥ 被拒点击不写任何节点数据字段（不覆盖刚跑完那张图的 success）；
 *   ⑦ 被拒点击不新增任务（守卫未被削弱）。
 * 用法：node --experimental-strip-types r6-fix1-feedback.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const X = "gen-x";
const A = "canvas-a";

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
// 忠实执行器桩：与 imageGenerationExecution.ts:265-267 / :414-415 同形（开始写 queued:false，结束写 success）
const FAITHFUL = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const step = async (ms) => new Promise((r) => setTimeout(r, ms));
  await step(5);
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await step(options?.dataOverride?.delayMs ?? 30);
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "success", error: undefined });
  return { success: true, cancelled: false };
};
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);
`;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "faithful:exec", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "faithful:exec") return { format: "module", source: FAITHFUL, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createRequire } = await import("node:module");
const requireRepo = createRequire(path.join(REPO, "package.json"));
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const toastModule = await import(pathToFileURL(path.join(SRC, "stores/toastStore.ts")).href);
const { useToastStore, toast } = toastModule;
const { useImageGeneratorExecution } = await import(
  pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href
);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
};

console.log("========== ① toast 通道本身（导入安全 / 是函数）==========");
check(typeof toast?.info === "function", "toast.info 存在且可调用（toastStore.ts:72-73）");
check(typeof useToastStore?.getState === "function", "useToastStore 是 zustand store（可在 Node 下 import，无 DOM 依赖）");
const toastCount = () => useToastStore.getState().toasts.length;
const toastTexts = () => useToastStore.getState().toasts.map((t) => `${t.type}:${t.message}`);

console.log("");
console.log("========== ② hook 返回形状不变 ==========");
const PROBE_DATA = { ...getDefaultImageGeneratorData(), prompt: "p", n: 4, status: "idle", label: "L" };
let captured = null;
function Probe() {
  captured = useImageGeneratorExecution(X, PROBE_DATA);
  return null;
}
const React = requireRepo("react");
const { renderToStaticMarkup } = requireRepo("react-dom/server");

const mkNode = () => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 4, status: "idle", label: "L" },
});
useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
useFlowStore.setState({ nodes: [mkNode()], edges: [], history: [], historyIndex: -1 });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1, isQueuePanelOpen: false });
renderToStaticMarkup(React.createElement(Probe));
check(Boolean(captured), "renderToStaticMarkup 后拿到 hook 返回值");
const keys = captured ? Object.keys(captured).sort().join(",") : "";
check(keys === "handleGenerate,model,resolvedSize,sizeValidationError", `返回键集合未变（实际 "${keys}"）`);
check(typeof captured?.handleGenerate === "function", "handleGenerate 仍是函数");

// node 数据快照（用于"被拒点击零副作用"）
const nodeData = () => JSON.parse(JSON.stringify(useFlowStore.getState().nodes.find((n) => n.id === X)?.data ?? null));
const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const activeJobs = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");
const nodeJobs = () => useQueueStore.getState().jobs.filter((j) => j.nodeId === X);
// 复刻 ImageGeneratorNode.tsx:215 的真实谓词
const canRunPredicate = () => {
  const d = useFlowStore.getState().nodes.find((n) => n.id === X)?.data;
  return Boolean(d?.prompt) && d?.status !== "loading" && !(d?.queued === true);
};

console.log("");
console.log("========== ③ 正常窗口真实可达（n=4, concurrency=1, 未暂停）==========");
const t0 = toastCount();
await captured.handleGenerate(); // 首次点击：整批 4 个 job 入队（挂起队列暂停/额度语义：concurrency=1 → 1 跑 3 等）
console.log(`  点击后：标记=${JSON.stringify(marker())} 队列=${nodeJobs().map((j) => j.status).join(",")}`);
check(toastCount() === t0, "④ 被接受的首次点击不产生提示（无误报）");
check(nodeJobs().length === 4, `整批 4 个 job 入队（实际 ${nodeJobs().length}）`);

// 等第 1 张跑完：执行器写 status=success, queued=false，但仍有 3 个 queued 任务
await sleep(120);
const windowState = {
  canRun: canRunPredicate(),
  queued: marker(),
  status: useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.status,
  active: activeJobs().length,
};
console.log(`  窗口现场：canRun=${windowState.canRun} 标记=${JSON.stringify(windowState.queued)} status=${JSON.stringify(windowState.status)} 活动任务=${windowState.active}`);
check(windowState.canRun === true, "按钮谓词为 true（按钮真实可点：prompt 有、status!=loading、标记非 true）");
check(windowState.queued === false && windowState.status === "success", "标记已 false 而 status=success（执行器 :265-267 + :414-415）");
check(windowState.active === 3, `仍有 3 个 queued 任务（实际 ${windowState.active}）`);

console.log("");
console.log("========== ⑤ 未暂停时点一次：必须被拒 + 必须给提示 + 零副作用 ==========");
const before1 = { toasts: toastCount(), jobs: nodeJobs().length, data: JSON.stringify(nodeData()) };
await captured.handleGenerate();
const after1 = { toasts: toastCount(), jobs: nodeJobs().length, data: JSON.stringify(nodeData()) };
console.log(`  toast: ${before1.toasts} → ${after1.toasts}；同节点 job: ${before1.jobs} → ${after1.jobs}`);
check(after1.toasts === before1.toasts + 1, "被拒点击产生了 1 条提示（F-R5-1 反馈通道生效）");
check(after1.jobs === before1.jobs, "守卫未被削弱：被拒点击不新增任务（REQ-002 性质保持）");
console.log(`  提示内容：${JSON.stringify(toastTexts().slice(-1))}`);
check(toastTexts().slice(-1)[0]?.startsWith("info:"), "提示类型为 info（临时提示，非 error 语义）");

console.log("");
console.log("========== ⑥ 快速连点 5 次（同一窗口）：去重与否 / 数据是否被写 ==========");
useQueueStore.setState({ paused: true }); // 冻结执行器写入，让"零副作用"断言确定化（paused 不参与守卫判定）
await sleep(20);
const frozen = JSON.stringify(nodeData());
const before6 = toastCount();
for (let i = 0; i < 5; i++) await captured.handleGenerate();
const after6 = { toasts: toastCount(), data: JSON.stringify(nodeData()), jobs: nodeJobs().length };
console.log(`  5 次连点：toast ${before6} → ${after6.toasts}；节点数据是否被改动=${after6.data !== frozen}`);
check(after6.toasts === before6 + 5, `不做去重：5 次被拒点击 → 5 条提示（实际 +${after6.toasts - before6}）`);
check(after6.data === frozen, "被拒点击不写任何节点数据字段（不覆盖 success 显示）");
check(marker() === false, "被拒点击不把 queued 写回 true");
console.log(`  ⇒ 窗口内连点 N 次的代价：N 条文案相同的 toast（每条 3s 自动消失，addToast 自带 setTimeout 清理）`);

console.log("");
console.log("========== ⑦ 反证：额度释放后点击必须被接受且无提示（不是「永远提示」）==========");
for (const j of nodeJobs()) if (j.status === "queued") useQueueStore.getState().cancel(j.id);
useQueueStore.setState({ paused: false });
await sleep(30);
const before7 = { toasts: toastCount(), jobs: nodeJobs().length, canRun: canRunPredicate() };
await captured.handleGenerate();
const after7 = { toasts: toastCount(), jobs: nodeJobs().length };
console.log(`  额度释放后：canRun=${before7.canRun} toast ${before7.toasts} → ${after7.toasts} job ${before7.jobs} → ${after7.jobs}`);
check(after7.jobs === before7.jobs + 1, "此时点击被接受（新增 1 个 job）");
check(after7.toasts === before7.toasts, "被接受的点击不产生'未生效'提示");

console.log("");
console.log(`RESULT: ${failures === 0 ? "F-R5-1 反馈通道成立、无误报、被拒点击零副作用、守卫未削弱（全部断言通过）" : `仍有 ${failures} 条断言未通过`}`);
process.exitCode = failures === 0 ? 0 : 1;
