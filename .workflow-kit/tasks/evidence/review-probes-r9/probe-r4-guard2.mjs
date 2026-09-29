/**
 * 独立审查探针 R4-4：守卫的六条既定属性（R1-R3 反复回归的地方）
 *   1 同步（同一 tick 内连点即拒，不依赖微任务/await）
 *   2 作用域 = 同 nodeId 且同 (canvasId ?? null)
 *   3 只认 queued||running，历史终态不参与
 *   4 不得写成"仅判定 running"（queued 也必须拦）
 *   5 不得写成全局单飞（不同节点/不同画布互不影响）
 *   6 paused 不参与判定
 * 用法：node --experimental-strip-types probe-r4-guard2.mjs
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
  for (const cand of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(cand)) return cand;
  return p;
}
const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 25));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
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

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const J = (o) => ({ nodeLabel: "L", modelLabel: "m", promptPreview: "p", ...o });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
};
const jobsFor = (nodeId, canvasId) =>
  useQueueStore.getState().jobs.filter(
    (j) => j.nodeId === nodeId && (j.canvasId ?? null) === canvasId && (j.status === "queued" || j.status === "running")
  );

console.log("并发=1、paused=false");
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });

console.log("[1] 同步：同一 tick 内连续 3 次 enqueue（不 await）");
const r1 = [0, 1, 2].map(() => useQueueStore.getState().enqueue(J({ nodeId: "n1", canvasId: "c0" })));
check("同一 tick 连点只放行 1 个", r1.filter(Boolean).length === 1, "返回值=" + JSON.stringify(r1));

console.log("[2] 作用域 = 同 nodeId 且同 (canvasId ?? null)");
check("同 nodeId 不同画布：允许（各自独立入队）", Boolean(useQueueStore.getState().enqueue(J({ nodeId: "n1", canvasId: "c1" }))), "c0 已占用后 c1 仍可入队");
check("同 nodeId 且 null 标注：与具体画布互不串味", Boolean(useQueueStore.getState().enqueue(J({ nodeId: "n1", canvasId: null }))), "(null) 独立于 c0/c1");
check("同 nodeId 同画布再次入队：拒绝", useQueueStore.getState().enqueue(J({ nodeId: "n1", canvasId: "c0" })) === "", "c0 重复被拒");
check("不同 nodeId 同画布：允许", Boolean(useQueueStore.getState().enqueue(J({ nodeId: "n2", canvasId: "c0" }))), "n2@c0 放行");
check("null 与 null 视为同一作用域：拒绝", useQueueStore.getState().enqueue(J({ nodeId: "n1", canvasId: null })) === "", "(null,n1) 重复被拒");

console.log("[3][4] 只认 queued||running（含『仅 running』的否定形态）");
useQueueStore.setState({ jobs: [], paused: true, concurrency: 4 });
useQueueStore.getState().enqueue(J({ nodeId: "n3", canvasId: "c0" }));
check("存在 queued（无 running）时再入队：拒绝", useQueueStore.getState().enqueue(J({ nodeId: "n3", canvasId: "c0" })) === "", "不是『仅判定 running』");
useQueueStore.setState({ paused: false });
await new Promise((r) => setTimeout(r, 5));
check("存在 running 时再入队：拒绝", useQueueStore.getState().enqueue(J({ nodeId: "n3", canvasId: "c0" })) === "", "状态=" + jobsFor("n3", "c0").map((j) => j.status).join(","));
useQueueStore.setState((s) => ({
  jobs: s.jobs.map((j) => (j.nodeId === "n3" ? { ...j, status: "success", finishedAt: Date.now() } : j)),
}));
check("只有历史终态（success）：允许重新生成", Boolean(useQueueStore.getState().enqueue(J({ nodeId: "n3", canvasId: "c0" }))), "历史任务不锁死重生成");

console.log("[5] 不是全局单飞");
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
useQueueStore.getState().enqueue(J({ nodeId: "n4", canvasId: "c0" }));
const solo = useQueueStore.getState().enqueue(J({ nodeId: "n5", canvasId: "c0" }));
check("额度被 n4 占住时，n5 仍可入队（非全局单飞）", Boolean(solo), "n4=" + jobsFor("n4", "c0").length + " n5=" + jobsFor("n5", "c0").length);

console.log("[6] paused 不参与判定");
useQueueStore.setState({ jobs: [], paused: true, concurrency: 2 });
const p1 = useQueueStore.getState().enqueue(J({ nodeId: "n6", canvasId: "c0" }));
const p2 = useQueueStore.getState().enqueue(J({ nodeId: "n6", canvasId: "c0" }));
check("暂停时首次点击：放行", Boolean(p1), "paused 不影响入队");
check("暂停时连点：仍被拒（守卫不跳过判定）", p2 === "", "这是暂停态假绿的防线");

console.log("");
console.log(`汇总：PASS ${results.filter((r) => r.ok).length} / FAIL ${results.filter((r) => !r.ok).length}（共 ${results.length}）`);
