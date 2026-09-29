/**
 * 独立审查探针 R2-A（TASK-006 第二轮 / 新缺陷假设）
 *
 * 假设：真实执行器 imageGenerationExecution.ts 的“取消”路径里，
 *   await resolveConnectedInputs(...)                      ← 行 192（真实含 IPC 往返）
 *   if (signal?.aborted) return { cancelled: true }        ← 行 205：**直接 return，不写 queued**
 *   ...
 *   updateNodeDataWithCanvas({status:"loading", queued:false})  ← 行 258-267：唯一的启动写
 * 即 abort 若落在这段窗口内，全程**没有任何一处写 queued:false**（grep 确认全文件仅 213/227/267
 * 三处写 queued，且都在行 205 之后）。而 QueuePanel.tsx:206-216 对 status==="running" 的任务
 * 提供“取消”按钮 → useQueueStore.cancel 的 running 分支（queueStore.ts:356-359）只做 abort()，
 * **不清节点标记**（只有 queued 分支才 clearNodeQueuedMarker）。
 * ⇒ 标记停留在 hook 写入的 queued:true，而该节点已无任何活动任务 → 永久“排队中”、按钮禁用。
 *
 * 本探针用忠实复刻上述写入序列的 mutant 执行器，走真实 enqueue/pump/cancel/hook 路径验证。
 *
 * 用法：node --experimental-strip-types probe-cancel-abort-lock.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");

// 解析窗口时长（模拟 resolveConnectedInputs 的 IPC 往返）；由命令行参数覆盖，用于对照组
const RESOLVE_MS = Number(process.argv[2] ?? 200);

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

const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { success: false, error: "节点不存在" };            // 行 181-184：不写 queued
  await new Promise((r) => setTimeout(r, ${RESOLVE_MS}));                // 行 192 resolveConnectedInputs（IPC）
  if (options?.signal?.aborted) return { success: false, cancelled: true }; // 行 205：不写 queued（关键）
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined }); // 行 258-267
  await new Promise((r) => setTimeout(r, 60));
  useFlowStore.getState().updateNodeData(nodeId, { status: "success", error: undefined }); // 行 405-418：不写 queued
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

const NODE_ID = "gen-cancel-lock";
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
useFlowStore.setState({
  nodes: [
    {
      id: NODE_ID,
      type: "imageGeneratorNode",
      position: { x: 0, y: 0 },
      data: { ...getDefaultImageGeneratorData(), prompt: "cancel window", n: 1, status: "idle" },
    },
  ],
  edges: [],
});

let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution(NODE_ID, useFlowStore.getState().nodes[0].data);
  handle = handleGenerate;
  return null;
}
renderToStaticMarkup(React.createElement(Probe));

const nodeOf = () => useFlowStore.getState().nodes.find((n) => n.id === NODE_ID)?.data ?? {};
const jobOf = () => useQueueStore.getState().jobs.find((j) => j.nodeId === NODE_ID);
const activeOf = () =>
  useQueueStore.getState().jobs.filter((j) => j.nodeId === NODE_ID && (j.status === "queued" || j.status === "running")).length;
// ImageGeneratorNode.tsx:215 的真实表达式
const canRun = (d) => Boolean(d.prompt) && d.status !== "loading" && !(d.queued === true);

console.log(`解析窗口 RESOLVE_MS=${RESOLVE_MS}ms（模拟 resolveConnectedInputs 的 IPC 往返）`);
console.log("步骤 1：单张（n=1）点击生成 → hook 写 queued:true");
await handle();
console.log(`  job=${jobOf()?.status}  活动=${activeOf()}  node.queued=${JSON.stringify(nodeOf().queued)}  canRun=${canRun(nodeOf())}`);

const CANCEL_AT = Number(process.argv[3] ?? Math.max(1, Math.floor(RESOLVE_MS / 4)));
console.log(`步骤 2：在解析窗口内点击 QueuePanel 的“取消”（运行中任务的取消按钮，QueuePanel.tsx:206-216）`);
await sleep(CANCEL_AT);
const job = jobOf();
console.log(`  取消前 job=${job?.status}；调用 useQueueStore.getState().cancel("${job?.id}")`);
useQueueStore.getState().cancel(job.id);

await sleep(RESOLVE_MS + 300);
const d = nodeOf();
const j = jobOf();
console.log("");
console.log("步骤 3：等一切结束");
console.log(`  job 终态=${j?.status}（finishedAt=${Boolean(j?.finishedAt)}）  活动任务数=${activeOf()}`);
console.log(`  node: queued=${JSON.stringify(d.queued)}  status=${JSON.stringify(d.status)}`);
console.log(`  ImageGeneratorNode.canRun = ${canRun(d)}`);
console.log("");
if (d.queued === true && activeOf() === 0 && j?.status === "cancelled") {
  console.log("RESULT: 永久锁——节点仍显示“排队中”、按钮禁用，而队列里该节点已无任何活动任务。");
  console.log("        重启也无法恢复：partialize 只写非 running 任务，cancelled 属终态、不参与 REQ-001 恢复；");
  console.log("        节点上的 queued:true 随 canvasStore 落盘，App.tsx:154 setNodes 再载入 flowStore。");
} else {
  console.log("RESULT: 未形成永久锁。");
}
