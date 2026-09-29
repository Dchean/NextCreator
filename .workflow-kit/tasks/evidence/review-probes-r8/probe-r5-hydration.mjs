/**
 * 审查探针（第 5 轮 · 独立审查者 · 第三发）：
 * 自愈订阅读的是 useQueueStore.getState().jobs —— 冷启动时若 flowStore 的节点先于队列水合被载入，
 * 该数组还是空的，"任何 true 都视为陈旧"就会把**上一次会话留下的合法标记**（其 job 仍在持久化队列里、
 * 待 REQ-001 恢复）提前清掉，于是按钮在"该节点确有排队任务"时变为可用。
 * 本探针回答三件事：
 *   A) 真实模块求值顺序下，队列水合与画布水合谁先完成？（决定上面那个窗口是否存在）
 *   B) 若窗口存在：载入节点后标记会不会被清、守卫会不会放行重复入队？
 *   C) 恢复路径（recoverPersistedQueuedJobs）的最终状态是否仍然正确？
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

const nodeData = { prompt: "p", n: 1, status: "idle", queued: true, label: "L", model: "m" };
globalThis.__NC_STORE_SEED__ = {
  "next-creator-canvases": JSON.stringify({
    state: {
      canvases: [{ id: A, name: "A", nodes: [{ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: nodeData }], edges: [] }],
      activeCanvasId: A,
    },
    version: 0,
  }),
  "generation-queue": JSON.stringify({
    state: {
      jobs: [{ id: "job-left", nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: 1 }],
      concurrency: 2,
    },
    version: 0,
  }),
};

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
// 执行器：故意长时间运行，让"恢复派发后的任务"停在 running/queued 上可观察
const SLOW = `
export const executeImageGeneration = async (nodeId, options) => {
  await new Promise((r) => setTimeout(r, 400));
  return { success: true, cancelled: false };
};
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);
`;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec") return { format: "module", source: SLOW, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 与 App.tsx 一致的求值顺序：Toolbar(→queueStore) 先于 canvasStore/flowStore
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);

console.log("========== A) 水合顺序：谁先落地（每 5ms 采样一次）==========");
let queueAtCanvasHydration = null;
for (let i = 0; i < 200; i++) {
  const c = useCanvasStore.getState();
  const q = useQueueStore.getState().jobs;
  if (c._hasHydrated && queueAtCanvasHydration === null) {
    queueAtCanvasHydration = { at: i * 5, jobs: q.length, statuses: q.map((j) => j.status) };
  }
  if (c._hasHydrated && q.length > 0) break;
  await sleep(5);
}
console.log(`  canvasStore._hasHydrated 变 true 的那一刻：queue.jobs=${JSON.stringify(queueAtCanvasHydration)}`);
console.log(`  ⇒ ${queueAtCanvasHydration && queueAtCanvasHydration.jobs > 0 ? "队列已先水合（App.tsx:154 setNodes 时 jobs 已就绪 → 自愈看到真实任务列表）" : "队列尚未水合（存在\"载入节点早于队列水合\"的窗口）"}`);

console.log("");
console.log("========== B) 模拟 App.tsx:154 setNodes（画布水合完成、用户看到节点）==========");
await sleep(600); // 让水合与恢复都跑完，先看最终态
const jobsNow = useQueueStore.getState().jobs;
console.log(`  水合+恢复后：jobs=${jobsNow.map((j) => `${j.nodeId}:${j.status}`).join(",")}`);
const persistedMarker = useCanvasStore.getState().canvases.find((c) => c.id === A)?.nodes.find((n) => n.id === X)?.data?.queued;
console.log(`  画布副本（落盘那份）queued=${JSON.stringify(persistedMarker)}`);

// 关键：把"载入节点"重放一次，观察自愈在 jobs 为空 / 非空两种情形下的行为
console.log("");
console.log("========== C) 若载入节点时队列尚未水合（jobs=[]），自愈会怎么做 ==========");
{
  // 用一个"队列为空"的等价状态重现该窗口（不做任何真实水合控制）
  const savedJobs = useQueueStore.getState().jobs;
  useQueueStore.setState({ jobs: [] });
  const canvasNodes = [{ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...nodeData, queued: true } }];
  useFlowStore.setState({ nodes: canvasNodes });
  await sleep(20);
  const afterEmpty = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
  // 该窗口内用户点一次生成：守卫看到的是什么？
  const admitted = useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
  console.log(`  jobs=[] 时载入 queued:true 的节点 → 自愈把标记改成 ${JSON.stringify(afterEmpty)}`);
  console.log(`  该窗口内点击生成：enqueue 返回${admitted ? "非空（放行 = 与持久化队列里那个 queued 任务重复）" : "空（被守卫拒绝）"}`);
  console.log(`  此时 jobs=${useQueueStore.getState().jobs.map((j) => `${j.nodeId}:${j.status}`).join(",")} ← 用户这一击的新任务已存在`);
  // 真实水合语义：zustand persist 的默认 merge 是 {...currentState, ...persistedState}
  const merged = { ...useQueueStore.getState(), ...{ jobs: savedJobs } };
  console.log(`  水合到达时（persist 默认 merge = 持久化状态覆盖内存状态）：jobs=${merged.jobs.map((j) => `${j.nodeId}:${j.status}`).join(",")}`);
  console.log(`  ⇒ 用户在窗口内点的那个任务${savedJobs.some((j) => j.id === admitted) ? "仍在队列里" : "不在队列里（被水合覆盖丢弃）"}`);
}
