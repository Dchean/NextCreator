/**
 * 独立审查探针 5（TASK-006 / REQ-002 修复引入的新缺陷）
 *
 * 假设：新守卫用 enqueue() 返回 "" 表示"未入队"，但**唯一的生产调用方**
 * useImageGeneratorExecution.ts:61-90 从不检查返回值，并且在入队循环之后**无条件**写
 *   updateNodeData(id, { queued: true, status: "idle" })
 * 于是"被拒绝的那次点击"仍会把节点标记为排队中。
 *
 * 关键：真实执行器只在**运行开始时**写 queued:false（imageGenerationExecution.ts:265-272），
 * 成功/失败/取消路径都**不写** queued（行 414-423 / 452-455 / 447）。
 * 所以只要那次被拒绝的点击发生在"该节点最后一个任务已经启动之后"，
 * 就再没有任何代码会清除 queued:true → 节点永久"排队中"、按钮永久禁用（= REQ-001 的症状）。
 *
 * 本探针验证这条路径**经 UI 可达**（而不是靠直接调用 handleGenerate 绕过按钮）：
 *   批量 n=2 + concurrency=2 → 两个 job 同时 running。
 *   第 1 个 job 结束（写 status=success，queued 仍为 false），第 2 个仍在运行 →
 *   此刻 ImageGeneratorNode.canRun 为 **true**（按钮可用），而该节点仍有活动任务。
 *   模拟用户点击 → 守卫拒绝 → 观察最终节点状态。
 *
 * 用法：node --experimental-strip-types probe-lock-via-ui.mjs
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

// 忠实复刻真实执行器的写入序列（imageGenerationExecution.ts）：
//   await resolveConnectedInputs(...)            ← 行 192（真实含 IPC 往返，这里 40ms）
//   写 { status:"loading", queued:false }        ← 行 265-272
//   ...生成...                                    ← 第一个 job 150ms / 第二个 900ms
//   写 { status:"success", ... }（**不含 queued**）← 行 414-423
let CALL_NO = 0;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec-faithful", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec-faithful") {
      return {
        format: "module",
        source: `export const executeImageGeneration = async (nodeId, options) => {
                   const { useFlowStore } = await import("@/stores/flowStore");
                   const { useCanvasStore } = await import("@/stores/canvasStore");
                   const flow = useFlowStore.getState();
                   const myCall = globalThis.__NC_CALL_NO__ = (globalThis.__NC_CALL_NO__ || 0) + 1;
                   const activeCanvasId = useCanvasStore.getState().activeCanvasId;
                   const visible = !options?.canvasId || options.canvasId === activeCanvasId
                     ? flow.nodes.some((n) => n.id === nodeId)
                     : Boolean(useCanvasStore.getState().canvases.find((c) => c.id === options.canvasId)?.nodes.some((n) => n.id === nodeId));
                   if (!visible) return { success: false, error: "节点不存在" };   // 行 183-185：不写 queued
                   await new Promise((r) => setTimeout(r, 40)); // resolveConnectedInputs
                   useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined }); // 行 265-272
                   await new Promise((r) => setTimeout(r, myCall === 1 ? 150 : 900));
                   useFlowStore.getState().updateNodeData(nodeId, { status: "success", error: undefined }); // 行 414-423：不写 queued
                   return { success: true, cancelled: false };
                 };
                 export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
globalThis.__NC_CALL_NO__ = CALL_NO;

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

const NODE_ID = "gen-batch-ui";
useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
useFlowStore.setState({
  nodes: [
    {
      id: NODE_ID,
      type: "imageGeneratorNode",
      position: { x: 0, y: 0 },
      data: { ...getDefaultImageGeneratorData(), prompt: "batch lock", n: 2 },
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
const activeOf = () =>
  useQueueStore.getState().jobs.filter((j) => j.nodeId === NODE_ID && (j.status === "queued" || j.status === "running")).length;
const jobCountOf = () => useQueueStore.getState().jobs.filter((j) => j.nodeId === NODE_ID).length;
// ImageGeneratorNode.tsx:215 的真实表达式（hasResolvedPrompt 用内联 prompt 代替）
const canRun = (d) => Boolean(d.prompt) && d.status !== "loading" && !(d.queued === true);

console.log("步骤 1：批量 n=2、concurrency=2 → 点一次生成（整批 2 个 job）");
await handle();
await sleep(200); // 两个 job 都已过"写 queued:false"、第 1 个即将结束
console.log(`  同节点 job 数=${jobCountOf()}，活动=${activeOf()}`);
console.log(`  node: queued=${JSON.stringify(nodeOf().queued)} status=${JSON.stringify(nodeOf().status)}`);

// 等第 1 个 job 结束、第 2 个仍在运行 —— 这正是"按钮变可用但仍有活动任务"的窗口
let windowSeen = false;
for (let i = 0; i < 60; i++) {
  const d = nodeOf();
  if (activeOf() > 0 && canRun(d)) {
    windowSeen = true;
    console.log("");
    console.log("步骤 2：捕获到 UI 可达窗口");
    console.log(`  活动任务=${activeOf()}（该节点最后一个 job 仍在运行），status=${JSON.stringify(d.status)}，queued=${JSON.stringify(d.queued)}`);
    console.log(`  ImageGeneratorNode.canRun = ${canRun(d)}  → 生成按钮处于**可用**状态`);
    break;
  }
  await sleep(25);
}
if (!windowSeen) {
  console.log("\n未捕获到窗口：退出（探针前提不成立）");
  process.exitCode = 1;
} else {
  const before = jobCountOf();
  console.log("");
  console.log("步骤 3：模拟用户在这个窗口点击生成（按钮可用 → 真实可达）");
  await handle();
  const after = jobCountOf();
  const dClick = nodeOf();
  console.log(`  守卫拒绝：同节点 job 数 ${before} → ${after}（新增 ${after - before}）`);
  console.log(`  但 hook 仍写入：queued=${JSON.stringify(dClick.queued)}，status=${JSON.stringify(dClick.status)}`);

  await sleep(1200); // 等最后一个 job 结束（真实完成路径不写 queued）
  const dEnd = nodeOf();
  const activeEnd = activeOf();
  console.log("");
  console.log("步骤 4：该节点所有任务均已结束");
  console.log(`  活动任务数=${activeEnd}，队列内同节点 job 数=${jobCountOf()}（全部为历史终态）`);
  console.log(`  node: queued=${JSON.stringify(dEnd.queued)} status=${JSON.stringify(dEnd.status)}`);
  console.log(`  ImageGeneratorNode.canRun = ${canRun(dEnd)}`);
  console.log("");
  if (dEnd.queued === true && activeEnd === 0) {
    console.log("RESULT: 节点被永久锁死在\"排队中\"——按钮禁用，且队列里没有任何活动任务会清除该标记。");
    console.log("        用户唯一出路是删除/重建节点（重启也无效：queued 随画布落盘，而队列里没有 queued 任务可供恢复逻辑处理）。");
  } else {
    console.log("RESULT: 未形成永久锁（标记被后续任务清除）。");
  }
}
