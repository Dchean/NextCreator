/**
 * 独立审查探针 4（TASK-006 / REQ-002）
 *
 * 目的：门禁只断言"同节点 job 数"，从不断言**被拒绝的那一次点击之后，节点 data.queued 是什么**。
 * useImageGeneratorExecution.ts:61-90 在 enqueue 循环之后**无条件**写 `queued: true, status: "idle"`，
 * 且完全忽略 enqueue 的返回值（新守卫用 "" 表示"未入队"）。本探针观察这条路径留下的节点状态。
 *
 * 执行器桩忠实复刻真实写入顺序（imageGenerationExecution.ts）：
 *   - 开始时写 { status:"loading", queued:false }   ← 真实：行 265-272
 *   - 结束时写 { status:"success" }                  ← 真实：行 414-423（**不含 queued**）
 *   - 提前返回路径（行 183-185「节点不存在」/ 行 205-207 已取消）不写任何 queued ← 真实：不写
 *
 * 用法：node --experimental-strip-types probe-ignored-rejection.mjs
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
        source: `const RUN_MS = 400;
                 export const executeImageGeneration = async (nodeId, options) => {
                   const { useFlowStore } = await import("@/stores/flowStore");
                   const flow = useFlowStore.getState();
                   // 真实顺序：先 await 解析输入（imageGenerationExecution.ts:192），之后才写这两行
                   await new Promise((r) => setTimeout(r, 40));
                   flow.updateNodeData(nodeId, { status: "loading", queued: false, error: undefined }); // 行 265-272
                   await new Promise((r) => setTimeout(r, RUN_MS));
                   flow.updateNodeData(nodeId, { status: "success", error: undefined }); // 行 414-423：不写 queued
                   return { success: true, cancelled: false };
                 };
                 export const getImageBatchCount = () => 1;`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 必须用**仓库内**的 react / react-dom 实例，否则 zustand(从 src/ 解析)与探针(从 TEMP 解析)
// 会拿到两份 React，renderToStaticMarkup 报 "Invalid hook call"。
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

const NODE_ID = "gen-lock";
useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
useFlowStore.setState({
  nodes: [
    {
      id: NODE_ID,
      type: "imageGeneratorNode",
      position: { x: 0, y: 0 },
      data: { ...getDefaultImageGeneratorData(), prompt: "lock me", n: 1 },
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
const canRun = (d) => Boolean(d.prompt) && d.status !== "loading" && !(d.queued === true);

console.log("=== 步骤 1：首次点击（应当入队并开始运行）===");
await handle();
console.log(`  同节点 job 数=${jobCountOf()}，活动=${activeOf()}，node.queued=${JSON.stringify(nodeOf().queued)}，status=${nodeOf().status}`);

// 等执行器走过"开始写 queued:false"（真实代码里这是入队后几百毫秒才发生的 IPC 之后）
await sleep(120);
console.log(`  执行器已启动后：node.queued=${JSON.stringify(nodeOf().queued)}，status=${nodeOf().status}，活动=${activeOf()}`);

console.log("\n=== 步骤 2：任务仍在运行时再点一次生成（守卫会拒绝这次入队）===");
const before = jobCountOf();
await handle();
const after = jobCountOf();
const d = nodeOf();
console.log(`  同节点 job 数 ${before} → ${after}（守卫拒绝：新增 ${after - before}）`);
console.log(`  但 hook 仍然写入：node.queued=${JSON.stringify(d.queued)}，node.status=${JSON.stringify(d.status)}`);
console.log(`  此刻 canRun=${canRun(d)}  ← 按钮已禁用、显示"排队中"，而队列里并没有属于这一次点击的任务`);

console.log("\n=== 步骤 3：等在飞的那个任务结束（真实执行器成功后不写 queued）===");
await sleep(700);
const dEnd = nodeOf();
const activeEnd = activeOf();
console.log(`  该节点活动任务数=${activeEnd}（队列里已没有可清理该标记的任务）`);
console.log(`  node.queued=${JSON.stringify(dEnd.queued)}，node.status=${JSON.stringify(dEnd.status)}，canRun=${canRun(dEnd)}`);
console.log("");
if (dEnd.queued === true && activeEnd === 0) {
  console.log("RESULT: 被拒绝的那次点击把节点永久留在\"排队中\"——没有任何活动任务会再清除该标记。");
  console.log("        （用户既无法生成，QueuePanel 里也没有可取消/可重试的任务来清标记）");
} else {
  console.log("RESULT: 标记被后续任务清除（未形成永久锁）。");
}
