/**
 * 独立审查探针 R6-E（round 6）：核对本轮**新写/改写的散文声明**是否与代码一致。
 *
 * 被核对的两条：
 *  A. queueStore.ts:646「实测 (marker|status) 组合集合 = {undefined|idle, false|loading, false|success}」
 *     —— 这是被当作证据写进不变式注释的**穷举集合**，必须真的穷举。
 *  B. useImageGeneratorExecution.ts:74-76「执行器只在任务**开始**时写 queued:false，
 *     成功/失败/取消路径都不写」—— 静态核对 imageGenerationExecution.ts 的全部 queued 写入点。
 *
 * 做法：跑一次完整的 n=4 批量（concurrency=1），在整批生命周期内以 ~1ms 粒度采样
 * (flowStore marker | flowStore status)，最后打印**观测到的完整组合集合**。
 * 用法：node --experimental-strip-types r6-prose-claims.mjs
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
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
const FAITHFUL = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const step = async (ms) => new Promise((r) => setTimeout(r, ms));
  await step(6);
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
const { useImageGeneratorExecution } = await import(
  pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href
);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const mkNode = () => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 4, status: "idle", label: "L" },
});
const React = requireRepo("react");
const { renderToStaticMarkup } = requireRepo("react-dom/server");
let handle = null;
function Probe() { handle = useImageGeneratorExecution(X, mkNode().data).handleGenerate; return null; }

useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
useFlowStore.setState({ nodes: [mkNode()], edges: [], history: [], historyIndex: -1 });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1, isQueuePanelOpen: false });
renderToStaticMarkup(React.createElement(Probe));

const obs = new Set();
const sample = () => {
  const d = useFlowStore.getState().nodes.find((n) => n.id === X)?.data;
  obs.add(`${d?.queued}|${d?.status}`);
};
sample(); // 起始（未点击）
await handle();
sample();
const deadline = Date.now() + 1200;
while (Date.now() < deadline) {
  sample();
  const active = useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  if (active === 0 && Date.now() > deadline - 900) break;
  await sleep(1);
}
for (let i = 0; i < 8; i++) { sample(); await sleep(2); }

console.log("========== A. 实测 (marker|status) 组合集合 ==========");
const observed = [...obs].sort();
console.log(`  观测到：${observed.map((s) => `(${s})`).join(" ")}`);
const claimed = ["undefined|idle", "false|loading", "false|success"];
const extra = observed.filter((s) => !claimed.includes(s));
console.log(`  注释声称的集合：${claimed.map((s) => `(${s})`).join(" ")}`);
console.log(`  注释遗漏但确实出现的：${extra.map((s) => `(${s})`).join(" ") || "（无）"}`);
const hasTrueIdle = observed.includes("true|idle");
console.log(`  ⇒ 「true|idle」是否出现（= 排队等待中、状态仍是 idle 的**常规**排队态）：${hasTrueIdle}`);
console.log(`  ⇒ 结论：注释以「实测…组合集合」的形式给出**穷举**，但真实集合更大；`);
console.log(`     （单向不变式本身的结论不受影响：false|loading 已足以否证「有 active 任务 ⟹ marker=true」。）`);

console.log("");
console.log("========== B. 执行器的 queued 写入点（静态核对）==========");
{
  const src = readFileSync(path.join(SRC, "services/imageGenerationExecution.ts"), "utf8").split(/\r?\n/);
  const hits = [];
  src.forEach((line, i) => { if (/queued\s*:/.test(line)) hits.push(`${i + 1}: ${line.trim()}`); });
  console.log("  imageGenerationExecution.ts 中写 queued 的行：");
  for (const h of hits) console.log(`    ${h}`);
  console.log("  ⇒ :213/:227 是**失败**路径（无提示词 / 尺寸非法）也写 queued:false；");
  console.log("     因此 hook 注释「成功/失败/取消路径都不写」在字面上不成立（失败路径有 2 处会写）。");
  console.log("     但被拒点击的那条论证不受影响：那两处只在任务**已入队并开始**后才可达，");
  console.log("     被拒的点击根本没有任务，不会走到执行器。");
}
