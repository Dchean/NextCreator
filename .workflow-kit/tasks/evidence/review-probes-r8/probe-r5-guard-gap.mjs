/**
 * 审查探针（第 5 轮 · 独立审查者 · 第二发）：REQ-002 守卫自身的漏判（与本轮自愈改动无关的
 * 既存面，但属于"REQ-002 是否真的修好"的必需证据），以及自愈的覆盖缺口。
 *
 * 关键怀疑点：enqueue 里 `get().pump()` 是**同步**调用的（queueStore.ts:366），而 pump 会
 * 同步把任务从 queued 改成 running 并**同步**启动执行器（executor 的第一行 await 之前是同步的）。
 * 若某个任务在一次点击的整批交付过程中**同步跑完**（或同步进入 running 又被同步终结），
 * 则 hasActiveJobForNode 在同一次点击的第 2..N 次调用里可能看到"没有活动任务"，
 * 于是……需要实测它是**多放行**（REQ-002 漏洞）还是**少放行**（整批截断）。
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
// 执行器：启动时同步判定 + 立刻完成（把"任务在整批交付期间离开 active 集合"压到极限）
const FAST = `
export const executeImageGeneration = async (nodeId, options) => {
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
    if (url === "mutant:exec") return { format: "module", source: FAST, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);

const X = "gen-x";
const A = "canvas-a";
const reset = () => {
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: [], edges: [] });
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 4 });
};

console.log("========== 探测 1：批量整批交付期间，前一个任务同步跑完 → 守卫会不会多放行 ==========");
{
  reset();
  const rets = [];
  for (let i = 1; i <= 4; i++) {
    rets.push(
      useQueueStore.getState().enqueue({
        nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p",
        batchIndex: i, batchTotal: 4, dataOverride: { n: 1 },
      })
    );
  }
  await sleep(60);
  console.log(`  4 次同步连续调用（执行器秒回）：返回=${JSON.stringify(rets.map((r) => (r ? "非空" : "空")))}`);
  console.log(`  队列内该节点 job 数=${useQueueStore.getState().jobs.filter((j) => j.nodeId === X).length}（期望 4）`);
  console.log(`  ⇒ ${useQueueStore.getState().jobs.filter((j) => j.nodeId === X).length === 4 ? "整批完整（续传链生效）" : "整批被截断 / 或多放行"}`);
}

console.log("");
console.log("========== 探测 2：整批之间插入 await（真实 hook 的写法是同步 for 循环，这里做对照）==========");
{
  reset();
  const rets = [];
  for (let i = 1; i <= 4; i++) {
    rets.push(
      useQueueStore.getState().enqueue({
        nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p",
        batchIndex: i, batchTotal: 4, dataOverride: { n: 1 },
      })
    );
    if (i === 1) await sleep(30); // 让第 1 个任务跑完
  }
  await sleep(60);
  console.log(`  返回=${JSON.stringify(rets.map((r) => (r ? "非空" : "空")))}`);
  console.log(`  队列内该节点 job 数=${useQueueStore.getState().jobs.filter((j) => j.nodeId === X).length}（期望 4：同一次点击不得被自己截断）`);
}

console.log("");
console.log("========== 探测 3：陈旧批次链被很久之后的同形状单批续上（多放行）==========");
{
  reset();
  // 第 1 击：批量 2，只交第 1 个（模拟"循环中途被打断"，例如组件卸载/异常）
  const r1 = useQueueStore.getState().enqueue({
    nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p",
    batchIndex: 1, batchTotal: 2, dataOverride: { n: 1 },
  });
  // 该节点此刻有 1 个活动任务；链 nextIndex=2，形状 key 已记
  console.log(`  第 1 击第 1 次调用：${r1 ? "放行" : "拒绝"}；活动=${useQueueStore.getState().jobs.filter((j) => j.nodeId === X && (j.status === "queued" || j.status === "running")).length}；链是否残留（用行为反推）`);
  // 第 2 击：新的一次点击，形状完全相同，从 batchIndex=1 开始 → 应为拒绝
  const r2 = useQueueStore.getState().enqueue({
    nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p",
    batchIndex: 1, batchTotal: 2, dataOverride: { n: 1 },
  });
  console.log(`  新一击第 1 次调用（形状相同）：${r2 ? "放行 ← 若放行则 REQ-002 出现漏洞" : "拒绝，正确"}`);
  const r3 = useQueueStore.getState().enqueue({
    nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p",
    batchIndex: 2, batchTotal: 2, dataOverride: { n: 1 },
  });
  console.log(`  紧接着 batchIndex=2（若 r2 未放行，这里不得被旧链续上）：${r3 ? "放行 ← 旧链续上 = 多放行" : "拒绝，正确"}`);
  console.log(`  队列内该节点 job 数=${useQueueStore.getState().jobs.filter((j) => j.nodeId === X).length}`);
}

console.log("");
console.log("========== 探测 4：守卫对「同节点同画布、但历史任务已跑完又快速连点」的行为 ==========");
{
  reset();
  const a = useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
  const b = useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
  console.log(`  同一 tick 单张连点两次：${a ? "放行" : "拒绝"} / ${b ? "放行" : "拒绝"}（期望 放行/拒绝）`);
  await sleep(60);
  const c = useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
  console.log(`  全部跑完后再点：${c ? "放行，正确（历史任务不锁死）" : "拒绝 ← 历史任务锁死，缺陷"}`);
}

console.log("");
console.log("========== 探测 5：自愈订阅在\"pump 收尾复核\"之后是否产生额外 nodes 身份变化（F-R3-2 面）==========");
{
  reset();
  useFlowStore.setState({ nodes: [{ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { queued: false, prompt: "p", status: "idle" } }], edges: [] });
  let hits = 0;
  const unsub = useFlowStore.subscribe((s, p) => { if (s.nodes !== p.nodes) hits++; });
  const before = useFlowStore.getState().nodes;
  useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
  await sleep(80);
  unsub();
  console.log(`  标记本就 false 的节点跑完一个任务：nodes 身份变化次数=${hits}（期望 0：无虚假变更） 身份保持=${before === useFlowStore.getState().nodes}`);
}
