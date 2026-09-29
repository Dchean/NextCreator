/**
 * 独立审查探针 11（TASK-006）—— 被拒点击造成永久锁后，是否还有清除路径？
 *
 * 复刻 probe-ignored-rejection 的锁死结果，然后检查两条"可能的出路"：
 *   ① 重启（画布落盘 queued=true，但队列里没有该节点的 queued 任务 → 恢复逻辑不会处理它）
 *   ② 对同节点的一个历史 error 任务点"重试"（QueuePanel.tsx:221 → retry → enqueue → 执行器启动时写 queued:false）
 *
 * 用法：node --experimental-strip-types probe-lock-escape.mjs
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
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec-faithful2", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec-faithful2") {
      return {
        format: "module",
        source: `export const executeImageGeneration = async (nodeId) => {
                   const { useFlowStore } = await import("@/stores/flowStore");
                   await new Promise((r) => setTimeout(r, 30));
                   // 忠实复刻行 265-272：启动时写 queued:false
                   useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
                   await new Promise((r) => setTimeout(r, 500));
                   useFlowStore.getState().updateNodeData(nodeId, { status: "success", error: undefined });
                   return { success: true, cancelled: false };
                 };
                 export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);`,
        shortCircuit: true,
      };
    }
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

const NODE_ID = "gen-lock-escape";
useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
useFlowStore.setState({
  nodes: [{ id: NODE_ID, type: "imageGeneratorNode", position: { x: 0, y: 0 },
            data: { ...getDefaultImageGeneratorData(), prompt: "lock", n: 2 } }],
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
const canRun = (d) => Boolean(d.prompt) && d.status !== "loading" && !(d.queued === true);

// 制造锁：批量 n=2 → 轮询捕获"第 1 个已结束（queued=false）、第 2 个仍在运行"的按钮可用窗口，
// 在窗口内点击（守卫拒绝）→ 永久排队中
await handle();
let windowHit = false;
for (let i = 0; i < 80; i++) {
  if (activeOf() > 0 && canRun(nodeOf())) {
    windowHit = true;
    break;
  }
  await sleep(20);
}
console.log(`窗口捕获=${windowHit}；点击前：活动=${activeOf()}，queued=${JSON.stringify(nodeOf().queued)}，canRun=${canRun(nodeOf())}`);
await handle();
await sleep(900);
console.log(`锁已形成：活动=${activeOf()}，queued=${JSON.stringify(nodeOf().queued)}，canRun=${canRun(nodeOf())}`);
if (nodeOf().queued !== true) {
  console.log("（本探针未复现锁；probe-lock-via-ui.mjs 已可靠复现）");
}

console.log("");
console.log("—— 出路 ①：重启 ——");
console.log("  该节点在队列里只剩历史终态任务；恢复逻辑只处理 status==='queued'（queueStore.ts:144-146）");
console.log("  → 恢复不会触碰它；画布上 queued=true 随画布水合回来 → 仍然锁死");
console.log("  （已由 probe-timeline.mjs / probe-restart-final.mjs 的顺序分析佐证）");

console.log("");
console.log("—— 出路 ②：对同节点一个历史 error 任务点重试 ——");
// 注入一个历史 error 任务（模拟该节点此前失败过的一次生成）
useQueueStore.setState({
  jobs: [
    ...useQueueStore.getState().jobs,
    { id: "hist-error-1", nodeId: NODE_ID, canvasId: null, nodeLabel: "L", modelLabel: "M",
      promptPreview: "P", status: "error", createdAt: 1, finishedAt: 2, error: "boom" },
  ],
});
console.log(`  重试前：queued=${JSON.stringify(nodeOf().queued)}，canRun=${canRun(nodeOf())}`);
useQueueStore.getState().retry("hist-error-1");
await sleep(120); // 等执行器启动并写 queued:false
console.log(`  重试后：queued=${JSON.stringify(nodeOf().queued)}，canRun=${canRun(nodeOf())}`);
console.log("");
console.log(
  nodeOf().queued === false
    ? "结论：重试确实能间接清掉该标记（执行器启动时写 queued:false）——但这是一条不直观的出路，\n" +
      "      且前提是该节点在队列面板里恰有一个可重试的历史失败任务。"
    : "结论：重试也无法清除该标记。"
);
