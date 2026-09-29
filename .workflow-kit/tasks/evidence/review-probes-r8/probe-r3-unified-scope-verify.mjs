/**
 * 自建验证探针（REPAIR R3 / F-R3-1 的机制级证据）
 *
 * 目的：把"标记 true→false 的**唯一**来源"限定为 queueStore 的清除函数。
 *   probe-r3-abnormal-scope-clear.mjs 用的执行器在任务启动时会写 queued:false（这是执行器的
 *   **合法**行为），所以它无法区分"queueStore 误清"与"任务真的开始了"——它的判据是
 *   "掉标记的瞬间还有什么任务 active"，因此任务一开始跑就会被判成复现。
 *
 * 本探针用**完全不碰节点数据**的执行器（与正式门禁的 mutant:exec-ok 同款），于是：
 *   · 标记若被抹掉，肇事者只可能是 queueStore 的 clearNodeQueuedMarker*；
 *   · 判据也更强：一次"真错"的清除发生在**仍有 nodeId=X 的 queued||running 任务**的时刻。
 *
 * 用法：node --experimental-strip-types probe-r3-unified-scope-verify.mjs
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
// 关键：执行器**绝不写节点数据**（不写 queued:false、不写 status）。
// 因此本探针里任何一次标记变化都只能来自 queueStore 的清除路径。
const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  await new Promise((r) => setTimeout(r, 15));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 300));
  return { success: true, cancelled: false };
};
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);
`;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec-nodewrite", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec-nodewrite") return { format: "module", source: EXEC_SRC, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const X = "gen-x";
const A = "canvas-a";
const B = "canvas-b";
const mkNode = () => ({
  id: X,
  type: "imageGeneratorNode",
  position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle" },
});

let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution(X, useFlowStore.getState().nodes[0].data);
  handle = handleGenerate;
  return null;
}

const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const activeForX = () =>
  useQueueStore.getState().jobs.filter((j) => j.nodeId === X && (j.status === "queued" || j.status === "running"));
const jobsOf = () => useQueueStore.getState().jobs.map((j) => `${j.nodeId}@${j.canvasId ?? "null"}:${j.status}`);

/** 记录每一次 true→false，并附带**那一刻** nodeId=X 的活动任务 */
function watchDrops() {
  const drops = [];
  let prev = marker();
  const unsub = useFlowStore.subscribe((s) => {
    const cur = s.nodes.find((n) => n.id === X)?.data?.queued;
    if (cur !== prev) {
      if (prev === true && cur !== true) {
        const act = activeForX().map((j) => `${j.canvasId ?? "null"}:${j.status}`);
        drops.push({ act, wrong: act.length > 0 });
      }
      prev = cur;
    }
  });
  return { drops, unsub };
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`        ${detail}`);
  if (!ok) failures++;
}

// ===========================================================================
console.log("【形态 2】复制画布：画布 A 的 X 任务结束 vs 画布 B 上同名节点 X 的排队任务");
console.log("        （执行器完全不写节点数据 → 标记的任何变化都只可能来自 queueStore）");
useCanvasStore.setState({
  canvases: [
    { id: A, name: "A", nodes: [mkNode()], edges: [] },
    { id: B, name: "B", nodes: [mkNode()], edges: [] },
  ],
  activeCanvasId: A,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
renderToStaticMarkup(React.createElement(Probe));

// 画布 A 上的长任务（占住唯一额度）
useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 500 } });
await sleep(80);
console.log(`  ① 画布 A 的任务在跑：${jobsOf().join(", ")}`);

// 切到画布 B（同名节点 X），点生成 → B 的 job 排队
useCanvasStore.setState({ activeCanvasId: B });
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
renderToStaticMarkup(React.createElement(Probe));
await handle();
console.log(`  ② 画布 B 点击后：${jobsOf().join(", ")}  标记=${JSON.stringify(marker())}`);

const w2 = watchDrops();
// 采样：只要 B 的 job 还是 queued，标记就必须是 true
let queuedWhileTrue = true;
for (let i = 0; i < 70; i++) {
  const bJob = useQueueStore.getState().jobs.find((j) => j.canvasId === B);
  if (bJob && bJob.status === "queued" && marker() !== true) queuedWhileTrue = false;
  await sleep(10);
}
const finalMarker = marker();
const finalJobs = jobsOf();
w2.unsub();

check(
  "形态2 A 的任务结束时，画布 B 仍有 queued 任务 → 标记必须保持 true",
  queuedWhileTrue,
  `B 的 job 处于 queued 期间标记始终为 true = ${queuedWhileTrue}`
);
check(
  "形态2 不存在\"仍有 nodeId=X 的活动任务却被清标记\"的时刻",
  w2.drops.every((d) => !d.wrong),
  w2.drops.length === 0
    ? "全程没有发生任何 true→false"
    : w2.drops.map((d) => `掉标记时活动任务=${JSON.stringify(d.act)}${d.wrong ? "（错）" : "（合法：已无活动任务）"}`).join("; ")
);
console.log(`  ③ 末尾：${finalJobs}  标记=${JSON.stringify(finalMarker)}`);

// ===========================================================================
console.log("");
console.log("【形态 1】canvasId=null 的遗留任务 vs 活动画布上同名节点的排队任务");
useCanvasStore.setState({
  canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }],
  activeCanvasId: A,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
renderToStaticMarkup(React.createElement(Probe));

useQueueStore.getState().enqueue({ nodeId: X, canvasId: null, nodeLabel: "X", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 500 } });
await sleep(80);
console.log(`  ① 遗留任务（canvasId=null）在跑：${jobsOf().join(", ")}`);

await handle(); // 活动画布 A 上点生成 → 作用域 (A,X) ≠ (null,X) → 放行
console.log(`  ② 点击后：${jobsOf().join(", ")}  标记=${JSON.stringify(marker())}`);

const w1 = watchDrops();
let secondQueuedWhileTrue = true;
for (let i = 0; i < 70; i++) {
  const aJob = useQueueStore.getState().jobs.find((j) => j.canvasId === A);
  if (aJob && aJob.status === "queued" && marker() !== true) secondQueuedWhileTrue = false;
  await sleep(10);
}
w1.unsub();

check(
  "形态1 遗留任务结束时，活动画布上仍有 queued 任务 → 标记必须保持 true",
  secondQueuedWhileTrue,
  `该 job 处于 queued 期间标记始终为 true = ${secondQueuedWhileTrue}`
);
check(
  "形态1 不存在\"仍有 nodeId=X 的活动任务却被清标记\"的时刻",
  w1.drops.every((d) => !d.wrong),
  w1.drops.length === 0
    ? "全程没有发生任何 true→false"
    : w1.drops.map((d) => `掉标记时活动任务=${JSON.stringify(d.act)}${d.wrong ? "（错）" : "（合法：已无活动任务）"}`).join("; ")
);

console.log("");
console.log(failures === 0 ? "RESULT: 判定作用域与清除落点已统一（无任何误清）。" : `RESULT: 仍有 ${failures} 项不满足。`);
process.exitCode = failures === 0 ? 0 : 1;
