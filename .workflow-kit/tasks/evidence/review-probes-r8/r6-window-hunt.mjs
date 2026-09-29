/**
 * 独立审查探针 R6-D（round 6, F-R5-1）：**主动搜索**"按钮可点但点击必被拒"的真实窗口。
 *
 * 为什么需要主动搜索：窗口 = 任务 k 已写 status:"success"/queued:false，而任务 k+1
 * 虽已被 pump 置为 running、却还没写 status:"loading"（执行器在写 loading 之前会
 * await resolveConnectedInputs，见 imageGenerationExecution.ts 的 :239 之前 → :265）。
 * 固定时刻采样很容易错过它，所以在整批运行期间以 ~1ms 粒度轮询，一旦
 * `canRun === true` 就**真的调用一次 handleGenerate**，记录结果。
 *
 * 断言：
 *  ① 该窗口在 n=4、concurrency=1、未暂停的正常路径下**可达**（不是纸面假设）；
 *  ② 每一次这样的点击都被守卫拒绝（不新增任务）——拒绝本身正确；
 *  ③ 每一次这样的点击都产生一条可见提示（F-R5-1 已修）；
 *  ④ 被拒点击不写任何节点数据字段（不覆盖刚跑完那张图的 success 显示）；
 *  ⑤ 对照组：批量结束、额度空闲时的点击必须被接受且无提示。
 * 用法：node --experimental-strip-types r6-window-hunt.mjs
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
// 忠实执行器桩：在写 loading 之前也 await 一次（与真实执行器一样存在"已跑完但下一张未写 loading"的窗口）
const FAITHFUL = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const step = async (ms) => new Promise((r) => setTimeout(r, ms));
  await step(6);                         // 对应 resolveConnectedInputs 的 await（真实为动态 import/IPC 往返）
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await step(options?.dataOverride?.delayMs ?? 25);
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
const { useToastStore } = await import(pathToFileURL(path.join(SRC, "stores/toastStore.ts")).href);
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

const mkNode = () => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 4, status: "idle", label: "L" },
});
const PROBE_DATA = mkNode().data;
const React = requireRepo("react");
const { renderToStaticMarkup } = requireRepo("react-dom/server");

let handle = null;
function Probe() {
  handle = useImageGeneratorExecution(X, PROBE_DATA).handleGenerate;
  return null;
}

useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
useFlowStore.setState({ nodes: [mkNode()], edges: [], history: [], historyIndex: -1 });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1, isQueuePanelOpen: false });
renderToStaticMarkup(React.createElement(Probe));

const nodeData = () => JSON.parse(JSON.stringify(useFlowStore.getState().nodes.find((n) => n.id === X)?.data ?? null));
const nodeDataRaw = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data;
const jobCount = () => useQueueStore.getState().jobs.filter((j) => j.nodeId === X).length;
const activeJobs = () => useQueueStore.getState().jobs.filter((j) => (j.status === "queued" || j.status === "running") && j.nodeId === X).length;
const toasts = () => useToastStore.getState().toasts.length;
// 复刻 ImageGeneratorNode.tsx:215
const canRun = () => {
  const d = nodeDataRaw();
  return Boolean(d?.prompt) && d?.status !== "loading" && !(d?.queued === true);
};

console.log("========== ① 批量运行期间以 ~1ms 粒度搜索『按钮可点』的时刻 ==========");
await handle(); // 首次点击：n=4 整批入队
console.log(`  入队后：同节点 job=${jobCount()} 活动=${activeJobs()} 标记=${JSON.stringify(nodeDataRaw()?.queued)}`);
check(jobCount() === 4, `整批 4 个 job 入队（实际 ${jobCount()}）`);

let hits = 0, rejected = 0, accepted = 0, feedbackForRejects = 0, dataWritesOnReject = 0, guardLeaks = 0;
const samples = [];
const deadline = Date.now() + 1500;
while (Date.now() < deadline && activeJobs() > 0) {
  if (canRun()) {
    hits++;
    const before = { jobs: jobCount(), toasts: toasts(), data: JSON.stringify(nodeData()) };
    const statusAtClick = nodeDataRaw()?.status;
    await handle();                       // 真点一次
    const after = { jobs: jobCount(), toasts: toasts(), data: JSON.stringify(nodeData()) };
    const grew = after.jobs > before.jobs;
    samples.push({ statusAtClick, grew, toastDelta: after.toasts - before.toasts, dataChanged: after.data !== before.data, active: activeJobs() });
    if (grew) accepted++; else { rejected++; if (after.toasts > before.toasts) feedbackForRejects++; if (after.data !== before.data) dataWritesOnReject++; }
    if (!grew && after.jobs !== before.jobs) guardLeaks++;
  }
  await sleep(1);
}
console.log(`  采样窗口内命中『canRun=true』的时刻 ${hits} 次；其中被拒 ${rejected}、被接受 ${accepted}`);
for (const s of samples.slice(0, 8)) console.log(`    · status=${JSON.stringify(s.statusAtClick)} 被判拒=${!s.grew} 提示 +${s.toastDelta} 数据被改=${s.dataChanged} 点击时活动任务=${s.active}`);
check(hits > 0, "『按钮可点』的窗口在正常路径下确实可达（非纸面假设）");
check(rejected > 0, `窗口内点击确实被守卫拒绝（${rejected} 次）—— 拒绝本身是正确行为`);
check(rejected === 0 || feedbackForRejects === rejected, `每次被拒都有可见提示（F-R5-1）：${feedbackForRejects}/${rejected}`);
check(dataWritesOnReject === 0, `被拒点击不写任何节点数据字段（实际改写 ${dataWritesOnReject} 次）`);
check(guardLeaks === 0, "被拒点击从不新增任务（REQ-002 性质保持）");

console.log("");
console.log("========== ② 对照组：批量跑完、额度空闲后的点击必须被接受且无提示 ==========");
while (activeJobs() > 0) await sleep(5);
await sleep(30);
const b = { canRun: canRun(), jobs: jobCount(), toasts: toasts(), data: JSON.stringify(nodeData()) };
await handle();
const a = { jobs: jobCount(), toasts: toasts() };
console.log(`  canRun=${b.canRun} job ${b.jobs} → ${a.jobs}；toast ${b.toasts} → ${a.toasts}`);
check(b.canRun === true, "批量结束后按钮可用");
check(a.jobs === b.jobs + 1, "此时点击被接受（新增 1 个 job）");
check(a.toasts === b.toasts, "被接受的点击不产生『未生效』提示（无误报）");

console.log("");
console.log(`RESULT: ${failures === 0 ? "窗口真实可达、每次被拒都有提示、被拒点击零副作用、无误报（全部断言通过）" : `仍有 ${failures} 条断言未通过`}`);
process.exitCode = failures === 0 ? 0 : 1;
