/**
 * 独立审查探针 3（TASK-006 / REQ-002）
 *
 * 直接驱动真实的 queueStore.enqueue / retry / cancel，绕开 hook，检查批次链
 * （batchChains / enqueueOriginRetry）的边界行为。所有断言对象都是公开可观察状态。
 *
 * 用法：node --experimental-strip-types probe-batch-chain.mjs
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

// 执行器：永不结束（模拟"任务一直活动"），便于观察入队判定本身
let HOLD = true;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:hold", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:hold") {
      return {
        format: "module",
        source: `export const executeImageGeneration = async () => {
                   if (globalThis.__NC_HOLD__) await new Promise((r) => { globalThis.__NC_RELEASE__ = r; });
                   return { success: true, cancelled: false };
                 };
                 export const getImageBatchCount = (data) => 1;`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
globalThis.__NC_HOLD__ = HOLD;

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "PASS" : "**FAIL**"}  ${name}\n         ${detail}`);
}

const batch = (nodeId, i, total, extra = {}) => ({
  nodeId,
  canvasId: null,
  nodeLabel: "L",
  modelLabel: "M",
  promptPreview: "P",
  batchIndex: i,
  batchTotal: total,
  dataOverride: { n: 1 },
  ...extra,
});

function reset() {
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
}

// 让"活动任务"保持在活动态：用一个不结束的执行器 + concurrency 足够小
// 注意 pump 会把 queued 变 running，只要 HOLD=true，running 就不会结束。

// ---------------------------------------------------------------------------
console.log("\n### 场景 1：正常批量 —— 4 个 job 必须完整入队");
reset();
{
  let ok = 0;
  for (let i = 1; i <= 4; i++) if (useQueueStore.getState().enqueue(batch("n1", i, 4))) ok++;
  const n = useQueueStore.getState().jobs.filter((j) => j.nodeId === "n1").length;
  check("场景1 整批完整入队", ok === 4 && n === 4, `enqueue 返回非空 ${ok} 次，队列内 ${n} 个 job（期望 4）`);
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 2：批量进行中再次点击（新的完整一批）必须被拒绝");
{
  const before = useQueueStore.getState().jobs.length;
  let ok = 0;
  for (let i = 1; i <= 4; i++) if (useQueueStore.getState().enqueue(batch("n1", i, 4))) ok++;
  const after = useQueueStore.getState().jobs.length;
  check("场景2 第二击被整批拒绝", ok === 0 && after === before, `第二次点击放行 ${ok} 个，队列 ${before}→${after}（期望 0 增长）`);
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 3：批次链是否会跨节点串味（节点 A 的链被节点 B 续上）");
reset();
{
  useQueueStore.getState().enqueue(batch("A", 1, 4)); // 开 A 的链，nextIndex=2
  useQueueStore.getState().enqueue(batch("B", 1, 4)); // 开 B 的链，nextIndex=2
  const aAfter1 = useQueueStore.getState().jobs.filter((j) => j.nodeId === "A").length;
  const bAfter1 = useQueueStore.getState().jobs.filter((j) => j.nodeId === "B").length;
  // A 的第 2 个调用必须还能续上 A 自己的链
  const okA = useQueueStore.getState().enqueue(batch("A", 2, 4));
  const aAfter2 = useQueueStore.getState().jobs.filter((j) => j.nodeId === "A").length;
  check(
    "场景3 两节点各自的链互不干扰",
    aAfter1 === 1 && bAfter1 === 1 && Boolean(okA) && aAfter2 === 2,
    `A 首点=${aAfter1}，B 首点=${bAfter1}；A 的续传返回=${JSON.stringify(okA)}，A 累计=${aAfter2}（期望 1/1/非空/2）`
  );
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 4：批量循环中途被打断后，链是否残留并被后续调用续上（危险：可能多放行一个）");
reset();
{
  // 一次点击声明了 batchTotal=4，但只提交了第 1 个（模拟循环中途异常/组件卸载）
  useQueueStore.getState().enqueue(batch("C", 1, 4));
  const afterFirst = useQueueStore.getState().jobs.filter((j) => j.nodeId === "C").length;
  // 现在用户改了提示词后重新点击同一节点、同一批量：形状键变化
  let ok = 0;
  for (let i = 1; i <= 4; i++) if (useQueueStore.getState().enqueue(batch("C", i, 4, { promptPreview: "CHANGED" }))) ok++;
  const total = useQueueStore.getState().jobs.filter((j) => j.nodeId === "C").length;
  check(
    "场景4 中途打断 + 改提示词重击：不得增长",
    ok === 0 && total === afterFirst,
    `重击放行 ${ok} 个，节点 C 任务数 ${afterFirst}→${total}（期望 0 增长，形状键变化即非续传）`
  );
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 5：形状键完全相同的新一击（同提示词、同批量、同参数）");
reset();
{
  useQueueStore.getState().enqueue(batch("D", 1, 4)); // 只交 1 个，链残留 nextIndex=2
  const afterFirst = useQueueStore.getState().jobs.filter((j) => j.nodeId === "D").length;
  // 新一击：序号从 1 开始 → 与 nextIndex=2 不匹配 → 应被拒绝
  let ok = 0;
  for (let i = 1; i <= 4; i++) if (useQueueStore.getState().enqueue(batch("D", i, 4))) ok++;
  const total = useQueueStore.getState().jobs.filter((j) => j.nodeId === "D").length;
  check(
    "场景5 形状完全相同的新一击也不得续上旧链",
    ok === 0 && total === afterFirst,
    `放行 ${ok} 个，节点 D 任务数 ${afterFirst}→${total}（期望 0 增长：新一击从 1 开始，对不上 nextIndex=2）`
  );
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 6：单张路径（无 batchIndex）连点 3 次只留 1 个");
reset();
{
  const single = { nodeId: "E", canvasId: null, nodeLabel: "L", modelLabel: "M", promptPreview: "P" };
  let ok = 0;
  for (let i = 0; i < 3; i++) if (useQueueStore.getState().enqueue(single)) ok++;
  const n = useQueueStore.getState().jobs.filter((j) => j.nodeId === "E").length;
  check("场景6 单张连点只留 1 个", ok === 1 && n === 1, `放行 ${ok} 次，队列内 ${n} 个（期望 1/1）`);
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 7：paused=true 时连点是否仍被守卫拦住（第五类假绿：暂停漏洞）");
reset();
{
  useQueueStore.setState({ paused: true });
  const single = { nodeId: "F", canvasId: null, nodeLabel: "L", modelLabel: "M", promptPreview: "P" };
  let ok = 0;
  for (let i = 0; i < 3; i++) if (useQueueStore.getState().enqueue(single)) ok++;
  const n = useQueueStore.getState().jobs.filter((j) => j.nodeId === "F").length;
  const statuses = useQueueStore.getState().jobs.filter((j) => j.nodeId === "F").map((j) => j.status).join("/");
  check("场景7 暂停时连点仍只留 1 个", ok === 1 && n === 1, `paused=true；放行 ${ok} 次，队列内 ${n} 个（status=${statuses}；期望 1/1）`);
  // 暂停时的批量：整批仍应完整入队（不能因为 paused 而截断）
  let okB = 0;
  for (let i = 1; i <= 4; i++) if (useQueueStore.getState().enqueue(batch("G", i, 4))) okB++;
  const nB = useQueueStore.getState().jobs.filter((j) => j.nodeId === "G").length;
  check("场景7b 暂停时批量整批入队", okB === 4 && nB === 4, `paused=true；放行 ${okB} 个，队列内 ${nB} 个（期望 4/4）`);
  useQueueStore.setState({ paused: false });
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 8：retry 与批量点击交错（来源标记 enqueueOriginRetry 的泄漏/错认）");
reset();
{
  // 一个历史 error job，带批量字段（重试批量中的某个任务）
  const failed = {
    id: "failed-1",
    nodeId: "H",
    canvasId: null,
    nodeLabel: "L",
    modelLabel: "M",
    promptPreview: "P",
    status: "error",
    createdAt: 1,
    batchIndex: 2,
    batchTotal: 4,
    dataOverride: { n: 1 },
  };
  useQueueStore.setState({ jobs: [failed] });
  useQueueStore.getState().retry("failed-1");
  const afterRetry = useQueueStore.getState().jobs.filter((j) => j.nodeId === "H").length;
  // 立刻再 retry 同一个（同一节点已有活动任务）→ 必须被拒
  useQueueStore.getState().retry("failed-1");
  const afterRetry2 = useQueueStore.getState().jobs.filter((j) => j.nodeId === "H").length;
  check("场景8 retry 只产生 1 个新任务", afterRetry === 2 && afterRetry2 === 2, `首次 retry 后同节点=${afterRetry}，再次 retry 后=${afterRetry2}（期望 2/2：1 个 error + 1 个新任务）`);
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 9：retry 之后若无活动任务，紧接着的批量点击是否正常（标记泄漏检查）");
reset();
{
  const failed2 = {
    id: "failed-2",
    nodeId: "I",
    canvasId: null,
    nodeLabel: "L",
    modelLabel: "M",
    promptPreview: "P",
    status: "error",
    createdAt: 1,
    batchIndex: 2,
    batchTotal: 4,
    dataOverride: { n: 1 },
  };
  useQueueStore.setState({ jobs: [failed2] });
  // 关键：即使 enqueue 因"已有活动任务"被拒绝，来源标记也必须被复位
  useQueueStore.getState().retry("failed-2");
  // 清掉活动任务，模拟任务结束（历史保留）后再点击一次完整批量
  useQueueStore.setState({
    jobs: useQueueStore.getState().jobs.map((j) => (j.status === "queued" || j.status === "running" ? { ...j, status: "success" } : j)),
  });
  const before = useQueueStore.getState().jobs.filter((j) => j.nodeId === "I").length;
  let ok = 0;
  for (let i = 1; i <= 4; i++) if (useQueueStore.getState().enqueue(batch("I", i, 4))) ok++;
  const after = useQueueStore.getState().jobs.filter((j) => j.nodeId === "I").length;
  check(
    "场景9 retry 后新批量仍能整批入队（来源标记未泄漏）",
    ok === 4 && after - before === 4,
    `放行 ${ok} 个，节点 I 任务数 ${before}→${after}（期望 4 个新增）`
  );
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 10：cancel 中断批量中途，链是否残留导致的后续异常");
reset();
{
  const id1 = useQueueStore.getState().enqueue(batch("J", 1, 4));
  useQueueStore.getState().enqueue(batch("J", 2, 4));
  // 取消第 1 个（queued 或 running）
  useQueueStore.getState().cancel(id1);
  const j1 = useQueueStore.getState().jobs.find((j) => j.id === id1);
  const activeJ = useQueueStore.getState().jobs.filter((j) => j.nodeId === "J" && (j.status === "queued" || j.status === "running")).length;
  // 继续交完这一批的 3、4（同一次点击的循环继续）
  const ok3 = useQueueStore.getState().enqueue(batch("J", 3, 4));
  const ok4 = useQueueStore.getState().enqueue(batch("J", 4, 4));
  const total = useQueueStore.getState().jobs.filter((j) => j.nodeId === "J").length;
  check(
    "场景10 取消其中一个后，同批剩余调用仍应被放行",
    j1?.status === "cancelled" && Boolean(ok3) && Boolean(ok4) && total === 4,
    `cancel 后状态=${j1?.status}（活动剩 ${activeJ}）；第 3/4 次调用返回=${JSON.stringify(ok3)}/${JSON.stringify(ok4)}；节点 J 共 ${total} 个（期望 cancelled/非空/非空/4）`
  );
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 11：整个批次交完后的连点判定");
reset();
{
  // 一次完整批量跑完后（4 个都入队，链 nextIndex=5），再点新的一批 → 应被拒
  for (let i = 1; i <= 4; i++) useQueueStore.getState().enqueue(batch("K", i, 4));
  const afterFirst = useQueueStore.getState().jobs.filter((j) => j.nodeId === "K").length;
  let ok = 0;
  for (let i = 1; i <= 4; i++) if (useQueueStore.getState().enqueue(batch("K", i, 4))) ok++;
  const total = useQueueStore.getState().jobs.filter((j) => j.nodeId === "K").length;
  check("场景11 整批交完后连点不增长", ok === 0 && total === afterFirst, `放行 ${ok} 个，节点 K 任务数 ${afterFirst}→${total}（期望 0 增长）`);
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 12：批次跑完（历史终态）后重新生成必须成功（不得锁死节点）");
reset();
{
  const nodeId = "M";
  for (let i = 1; i <= 4; i++) useQueueStore.getState().enqueue(batch(nodeId, i, 4));
  // 全部落终态
  useQueueStore.setState({
    jobs: useQueueStore.getState().jobs.map((j) => (j.status === "queued" || j.status === "running" ? { ...j, status: "success" } : j)),
  });
  const before = useQueueStore.getState().jobs.filter((j) => j.nodeId === nodeId).length;
  let ok = 0;
  for (let i = 1; i <= 4; i++) if (useQueueStore.getState().enqueue(batch(nodeId, i, 4))) ok++;
  const after = useQueueStore.getState().jobs.filter((j) => j.nodeId === nodeId).length;
  check("场景12 历史终态后重新生成成功", ok === 4 && after - before === 4, `放行 ${ok} 个，新增 ${after - before}（期望 4 个新增）`);
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 13：跨画布同名 nodeId（链按 nodeId 键，是否被另一画布续上）");
reset();
{
  // 画布 X 与画布 Y 各有一个 id 相同的节点（复制画布会保留 node.id）
  const okX1 = useQueueStore.getState().enqueue(batch("SAME", 1, 4, { canvasId: "canvasX" }));
  const okY1 = useQueueStore.getState().enqueue(batch("SAME", 1, 4, { canvasId: "canvasY" }));
  const afterBoth = useQueueStore.getState().jobs.length;
  // 画布 Y 的第 2 次调用：形状键含 canvasId，X 的链已被 Y 覆盖 → Y 应能续
  const okY2 = useQueueStore.getState().enqueue(batch("SAME", 2, 4, { canvasId: "canvasY" }));
  // 画布 X 的第 2 次调用：X 的链已被 Y 覆盖 → 可能被误拒（合法批量被截断）
  const okX2 = useQueueStore.getState().enqueue(batch("SAME", 2, 4, { canvasId: "canvasX" }));
  const total = useQueueStore.getState().jobs.length;
  check(
    "场景13 跨画布同 nodeId：两边的批量都不应被截断",
    Boolean(okX1) && Boolean(okY1) && Boolean(okY2) && Boolean(okX2),
    `X1=${JSON.stringify(okX1)} Y1=${JSON.stringify(okY1)}（此后共 ${afterBoth} 个）Y2=${JSON.stringify(okY2)} X2=${JSON.stringify(okX2)}；共 ${total} 个（期望 4 次都非空）`
  );
}

// ---------------------------------------------------------------------------
console.log("\n### 场景 14：批量链是否会无限增长（跨画布/跨节点泄漏 = 内存与陈旧判定）");
reset();
{
  // 每完成一次"第 1 个调用"就留下一条链；模拟大量节点
  for (let i = 0; i < 500; i++) useQueueStore.getState().enqueue(batch("leak-" + i, 1, 4));
  const totalJobs = useQueueStore.getState().jobs.length;
  check(
    "场景14 链随节点数增长（观察项，非断言失败）",
    true,
    `500 个不同节点各留下 1 条链 → 队列内 ${totalJobs} 个 job（jobs 上限 200）。这是模块级 Map，无上限、无清理时机`
  );
}

console.log("\n==================== 汇总 ====================");
const bad = results.filter((r) => !r.ok);
console.log(`通过 ${results.length - bad.length}/${results.length}`);
if (bad.length) {
  console.log("未通过：");
  for (const b of bad) console.log(`  - ${b.name}`);
}
process.exitCode = bad.length ? 1 : 0;
