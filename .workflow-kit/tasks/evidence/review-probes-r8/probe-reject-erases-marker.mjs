/**
 * 独立审查探针 R2-B（TASK-006 第二轮 / REQUIRED-1：拒绝分支是否会抹掉**合法刚写下**的 queued 标记）
 *
 * 场景（真实连点，非人造）：
 *   · concurrency=1，另有一个节点 Z 的 running 任务占满并发额度；
 *   · 用户在节点 A 上**快速点两次**（按钮在两次点击时都可用：此刻 A 还没有任何任务，
 *     hook 的 queued:true 写在 await getConnectedInputDataAsync 之后，两次点击都先进入该 await）；
 *   · 第 1 次点击守卫放行 → 入队 → hook 写 queued:true（A 的 job 因额度被占而停在 queued）；
 *   · 第 2 次点击守卫拒绝 → queueStore.enqueue 的拒绝分支调用 clearNodeQueuedMarker
 *     → 把第 1 次点击**刚刚合法写下**的 queued:true 抹成 false。
 * 结果：UI 显示“未排队”（无“排队中”反馈、按钮可用），而该节点确实有一个 job 在排队等待。
 * 即标记语义（作者注释：“queued === 本节点确实有活动任务”）在拒绝分支被破坏。
 *
 * 用法：node --experimental-strip-types probe-reject-erases-marker.mjs
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

// 忠实写入序列的执行器（imageGenerationExecution.ts）：开始时写 loading+queued:false，成功不写 queued
const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { success: false, error: "节点不存在" };
  await new Promise((r) => setTimeout(r, 20));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await new Promise((r) => setTimeout(r, 120));
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

// 放慢输入解析路径（与门禁用例 E / 真实 IPC 往返同构，见 scripts/queue-regression.mjs:925-935）
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
const jobsOf = (id) => useQueueStore.getState().jobs.filter((j) => j.nodeId === id);
const activeOf = (id) => jobsOf(id).filter((j) => j.status === "queued" || j.status === "running").length;
const canRun = (d) => Boolean(d.prompt) && d.status !== "loading" && !(d.queued === true);

// 用节点 Z 占满并发额度（concurrency=1）——Z 的任务直接入队，不经过按钮
useQueueStore.getState().enqueue({ nodeId: Z, canvasId: null, nodeLabel: "Z", modelLabel: "m", promptPreview: "z" });
await sleep(120);
console.log("步骤 0：额度占位");
console.log(`  Z: ${jobsOf(Z).map((j) => j.status).join(",")}（concurrency=${useQueueStore.getState().concurrency}）`);

console.log("");
console.log("步骤 1：用户在节点 A 上快速点两次（两次点击时按钮都可用：A 尚无任务、hook 的标记写在 await 之后）");
const p1 = handle();
const p2 = handle();
await Promise.all([p1, p2]);

const jobsA = jobsOf(A);
console.log(`  A 的 job 数=${jobsA.length}（守卫生效：连点未增长）  状态=${jobsA.map((j) => j.status).join(",")}`);
const dMid = dataOf(A);
console.log(`  此刻 A 确实有排队中的任务：active=${activeOf(A)}`);
console.log(`  但 node.data.queued = ${JSON.stringify(dMid.queued)}   status=${JSON.stringify(dMid.status)}`);
console.log(`  ImageGeneratorNode.canRun = ${canRun(dMid)}（按钮可用）／“排队中”文案(isQueued)= ${dMid.queued === true}`);
console.log("");
if (activeOf(A) > 0 && dMid.queued !== true) {
  console.log("RESULT: 不一致——A 有活动任务（queued）却显示“未排队”。第 2 次点击的**拒绝分支**抹掉了");
  console.log("        第 1 次点击刚刚合法写下的 queued:true，用户看不到“排队中”反馈，可继续点击（被静默丢弃）。");
} else {
  console.log("RESULT: 标记与活动任务一致（未复现）。");
}

await sleep(600);
console.log("");
console.log(`结束后 A: queued=${JSON.stringify(dataOf(A).queued)} status=${JSON.stringify(dataOf(A).status)} active=${activeOf(A)}`);
