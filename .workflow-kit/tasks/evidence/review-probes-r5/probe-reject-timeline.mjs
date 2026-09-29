/**
 * 独立审查探针 R2-C（TASK-006 第二轮 / REQUIRED-1 时间线）
 *
 * 探针 R2-B 显示：拒绝分支的 clearNodeQueuedMarker 是**异步**的
 * （`void import("@/stores/flowStore").then(...)`，queueStore.ts:526-559），
 * 因此它落到 flowStore 的时刻晚于"同一次连点中被放行的第 1 次点击"所写的 queued:true。
 *
 * 本探针用逐 10ms 采样把时间线画出来，并让被放行的 job 长时间停在 queued
 * （额度由另一个节点的长任务占满），从而回答：
 *   "UI 能否显示'未排队'而该节点确实有任务在排队？"
 *
 * 用法：node --experimental-strip-types probe-reject-timeline.mjs
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

// 长任务执行器：Z 的任务长时间占住额度；A 的被放行任务因此长时间停在 queued，便于采样
const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { success: false, error: "节点不存在" };
  await new Promise((r) => setTimeout(r, 20));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await new Promise((r) => setTimeout(r, nodeId === "gen-z" ? 4000 : 80));
  useFlowStore.getState().updateNodeData(nodeId, { status: "success", error: undefined });
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
    if (url === "mutant:exec") return { format: "module", source: EXEC_SRC, shortCircuit: true };
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
const { useImageGeneratorExecution } = await import(
  pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href
);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const A = "gen-a";
const Z = "gen-z";
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
useFlowStore.setState({
  nodes: [
    { id: A, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...getDefaultImageGeneratorData(), prompt: "A", n: 1, status: "idle" } },
    { id: Z, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...getDefaultImageGeneratorData(), prompt: "Z", n: 1, status: "idle" } },
  ],
  edges: [],
});
useFlowStore.setState({
  getConnectedInputDataAsync: async () => {
    await sleep(60);
    return { prompt: undefined, images: [], files: [] };
  },
});

let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution(A, useFlowStore.getState().nodes[0].data);
  handle = handleGenerate;
  return null;
}
renderToStaticMarkup(React.createElement(Probe));

const dataOf = (id) => useFlowStore.getState().nodes.find((n) => n.id === id)?.data ?? {};
const activeOf = (id) =>
  useQueueStore.getState().jobs.filter((j) => j.nodeId === id && (j.status === "queued" || j.status === "running")).length;
const canRun = (d) => Boolean(d.prompt) && d.status !== "loading" && !(d.queued === true);

useQueueStore.getState().enqueue({ nodeId: Z, canvasId: null, nodeLabel: "Z", modelLabel: "m", promptPreview: "z" });
await sleep(150);
console.log(`额度占位：Z=${useQueueStore.getState().jobs.find((j) => j.nodeId === Z)?.status}，concurrency=1`);

const t0 = Date.now();
console.log("");
console.log("在节点 A 上连点两次（按钮两次点击时都可用）；Z 的任务占住额度 4s，A 的任务会一直停在 queued");
console.log("时间(ms) | A.queued | A.status | A活动任务 | canRun | job状态");
const p1 = handle();
const p2 = handle();

const timeline = [];
let flagSeen = false;
for (let i = 0; i < 90; i++) {
  const d = dataOf(A);
  const j = useQueueStore.getState().jobs.find((x) => x.nodeId === A);
  const act = activeOf(A);
  const line = { t: Date.now() - t0, queued: d.queued, status: d.status, act, canRun: canRun(d), job: j?.status };
  if (i < 30 || line.queued !== timeline[timeline.length - 1]?.queued) {
    console.log(
      `${String(line.t).padStart(8)} | ${String(line.queued).padEnd(8)} | ${String(line.status).padEnd(8)} | ${String(line.act).padEnd(9)} | ${String(line.canRun).padEnd(6)} | ${line.job}`
    );
  }
  timeline.push(line);
  // 关键不一致：A 确实有活动任务，但标记已被拒绝分支的异步清除抹掉
  if (!flagSeen && act > 0 && line.job === "queued" && line.queued !== true) {
    flagSeen = true;
    console.log("");
    console.log(`>>> ${line.t}ms 捕获不一致：A 有 queued 任务（job=queued, active=${act}），但 node.data.queued=${JSON.stringify(line.queued)}`);
    console.log(`    此时 UI：canRun=${line.canRun}（按钮可用），“排队中”反馈=${line.queued === true}（不显示）`);
  }
  await sleep(10);
}
await Promise.all([p1, p2]);

console.log("");
console.log(`采样 ${timeline.length} 次（约 ${Date.now() - t0}ms）`);
const seen = new Set(timeline.map((l) => `${l.queued}|${l.job}`));
console.log("出现过的 (node.queued | job状态) 组合：", [...seen].map((s) => `(${s})`).join(" "));
console.log("");
if (flagSeen) {
  console.log("RESULT: 复现——被拒绝的那次点击把同一次连点里**合法放行**的第 1 个任务的 queued 标记抹掉了；");
  console.log("        在任务真正等待期间 UI 显示“未排队”、按钮可用（可继续点击并被静默丢弃）。");
} else {
  console.log("RESULT: 未捕获到该不一致。");
  console.log("        时间线中 queued:true 与 job=queued 是否曾同时出现：", timeline.some((l) => l.queued === true && l.job === "queued"));
}
