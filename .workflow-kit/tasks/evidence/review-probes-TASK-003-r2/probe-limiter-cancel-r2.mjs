/**
 * 审查者自写探针（TASK-003 r2）—— REQ-005 额度不变量 + REQ-006 取消完整性 + 非活动画布标记
 * 只跑候选树。不依赖门禁脚本的断言，独立构造反例。
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = process.env.NC_ROOT ? path.resolve(process.env.NC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.__NC_STORE_SEED__ = {};

const STUBS = {
  "@xyflow/react": `export const ReactFlow=()=>null;export const Background=()=>null;export const Controls=()=>null;
    export const MiniMap=()=>null;export const Panel=()=>null;export const Handle=()=>null;export const useReactFlow=()=>({});
    export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;export const addEdge=(e,es)=>es;
    export const MarkerType={};export const Position={};export const ConnectionLineType={};export const SelectionMode={};
    export const useStore=()=>({});export const getBezierPath=()=>["","",0,0];export const BaseEdge=()=>null;
    export const EdgeLabelRenderer=()=>null;export const useNodes=()=>[];export const useEdges=()=>[];export default {};`,
  "@tauri-apps/api/core": `export const invoke=async()=>{throw new Error("stub invoke");};
    export const Channel=class{};export const convertFileSrc=(p)=>p;export default {};`,
  "@tauri-apps/api/event": `export const listen=async()=>()=>{};export const emit=async()=>{};export default {};`,
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}
    async get(k){return (globalThis.__NC_STORE_SEED__||{})[k] ?? null;}
    async set(){}async save(){}async delete(){}async keys(){return [];}}
    export const load=async()=>new Store();export default {load};`,
  "@tauri-apps/plugin-fs": `export const readFile=async()=>new Uint8Array();export const writeFile=async()=>{};export const exists=async()=>false;export const mkdir=async()=>{};export const remove=async()=>{};export const stat=async()=>({});export default {};`,
  "@tauri-apps/plugin-dialog": `export const open=async()=>null;export const save=async()=>null;export const message=async()=>{};export const ask=async()=>false;export const confirm=async()=>false;export default {};`,
  "@tauri-apps/plugin-opener": `export const openUrl=async()=>{};export const openPath=async()=>{};export const revealItemInDir=async()=>{};export default {};`,
};
function withTs(p) {
  if (existsSync(p) && path.extname(p)) return p;
  for (const c of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(c)) return c;
  return p;
}
const GATE = { provider: "ok", gate: null };   // gate: {entered, wait}
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGeneration") return { url: "mutant:gen", shortCircuit: true };
    if (spec === "@/services/fileStorageService") return { url: "mutant:fs", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const base = fileURLToPath(new URL(spec, context.parentURL));
      const t = withTs(base);
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:gen") {
      return { format: "module", shortCircuit: true, source: `
        export const generateImage = async (req, key, signal) => {
          const g = globalThis.__NC_GATE__;
          if (g) { g.markEntered(); await g.wait; }
          if (globalThis.__NC_GEN_ERROR__) return { error: "provider error", errorDetails: { code: 500 } };
          if (globalThis.__NC_GEN_EMPTY__) return { text: "no image" };
          return { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="], text: "t" };
        };
        export const editImage = generateImage; export default {};` };
    }
    if (url === "mutant:fs") {
      const real = JSON.stringify(pathToFileURL(path.join(SRC, "services/fileStorageService.ts")).href);
      return { format: "module", shortCircuit: true, source: `
        import { saveImage as realSaveImage } from ${real};
        export * from ${real};
        export async function saveImage(...args) {
          const g = globalThis.__NC_SAVE_GATE__;
          if (g) { g.markEntered(); await g.wait; }
          return realSaveImage(...args);
        }` };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const lim = await import(pathToFileURL(path.join(SRC, "services/concurrencyLimiter.ts")).href);
const { executeImageGeneration } = await import(pathToFileURL(path.join(SRC, "services/imageGenerationExecution.ts")).href);

let fails = 0;
function chk(name, ok, detail) {
  console.log(`  ${ok ? "[OK]  " : "[FAIL]"} ${name}`);
  if (detail) console.log(`          ${detail}`);
  if (!ok) fails++;
}

console.log("=".repeat(78));
console.log("== REQ-005 额度不变量（自写探针）==");
lim.resetGlobalConcurrencyLimiter();
chk("默认上限 = 4（= UI 允许的最大并发）", lim.getGlobalConcurrencyLimit() === 4, `实际=${lim.getGlobalConcurrencyLimit()}`);

// 幂等归还：同一 release 连调 3 次只扣一次
lim.resetGlobalConcurrencyLimiter();
lim.setGlobalConcurrencyLimit(2);
const r1 = lim.tryAcquireGlobalSlot(); const r2 = lim.tryAcquireGlobalSlot();
const over = lim.tryAcquireGlobalSlot();
r1(); r1(); r1();
chk("取满后第 3 次返回 null；同一 release 连调 3 次只扣一次（不放大额度）",
  over === null && lim.getInFlightCount() === 1, `over=${over} inFlight=${lim.getInFlightCount()}（期望 1）`);
r2();
chk("全部归还后 inFlight=0（不泄漏）", lim.getInFlightCount() === 0, `inFlight=${lim.getInFlightCount()}`);

// limit=1 + 1 持有者 + 2 等待者：一次归还只唤醒一个
lim.resetGlobalConcurrencyLimiter();
lim.setGlobalConcurrencyLimit(1);
const hold = lim.tryAcquireGlobalSlot();
const wA = lim.acquireGlobalSlot(); const wB = lim.acquireGlobalSlot();
await new Promise((r) => setTimeout(r, 10));
const waitersBefore = lim.getWaiterCount();
hold();
const gA = await wA;
let peak = lim.getInFlightCount();
const gB = await Promise.race([wB, new Promise((r) => setTimeout(() => r("timeout"), 120))]);
chk("limit=1：一次归还原只唤醒一个等待者，且任一时刻在途<=1",
  waitersBefore === 2 && Boolean(gA) && gB === "timeout" && peak <= 1,
  `归还前等待者=${waitersBefore} 归还后 inFlight=${peak} 第二等待者=${gB === "timeout" ? "仍阻塞（正确）" : "被超额放行"}`);
if (gA) gA();
if (gB !== "timeout" && gB) gB();
else { lim.resetGlobalConcurrencyLimiter(); }

// 复位代数：陈旧许可归还不得误扣新一轮
lim.resetGlobalConcurrencyLimiter();
const stale = lim.tryAcquireGlobalSlot();
lim.resetGlobalConcurrencyLimiter();
lim.setGlobalConcurrencyLimit(2);
const fresh = lim.tryAcquireGlobalSlot();
stale();  // 陈旧归还
chk("复位后陈旧许可归还**不**误扣新一轮计数", lim.getInFlightCount() === 1, `inFlight=${lim.getInFlightCount()}（期望 1）`);
fresh();

// 等待中 abort
lim.resetGlobalConcurrencyLimiter();
lim.setGlobalConcurrencyLimit(1);
const h2 = lim.tryAcquireGlobalSlot();
const ac = new AbortController();
const wp = lim.acquireGlobalSlot(ac.signal);
await new Promise((r) => setTimeout(r, 10));
ac.abort();
const aborted = await wp;
chk("等待中 abort → 返回 null、不占额度、不残留等待者",
  aborted === null && lim.getWaiterCount() === 0 && lim.getInFlightCount() === 1,
  `返回值=${aborted} 等待者=${lim.getWaiterCount()} 在途=${lim.getInFlightCount()}`);
h2();
// 预取消
lim.resetGlobalConcurrencyLimiter();
const preAc = new AbortController(); preAc.abort();
const pre = await lim.acquireGlobalSlot(preAc.signal);
chk("预先 abort 的 signal → 立即返回 null", pre === null, `返回值=${pre}`);

// 限额钳制
lim.resetGlobalConcurrencyLimiter();
lim.setGlobalConcurrencyLimit(0); const lo = lim.getGlobalConcurrencyLimit();
lim.setGlobalConcurrencyLimit(999); const hi = lim.getGlobalConcurrencyLimit();
lim.setGlobalConcurrencyLimit(NaN); const nan = lim.getGlobalConcurrencyLimit();
chk("限额钳制：0→1、999→16、NaN→默认 4", lo === 1 && hi === 16 && nan === 4, `0→${lo}, 999→${hi}, NaN→${nan}`);
lim.resetGlobalConcurrencyLimiter();

// 公平性：有等待者时 tryAcquire 不插队
lim.resetGlobalConcurrencyLimiter();
lim.setGlobalConcurrencyLimit(1);
const h3 = lim.tryAcquireGlobalSlot();
const wFair = lim.acquireGlobalSlot();
await new Promise((r) => setTimeout(r, 10));
const steal = lim.tryAcquireGlobalSlot();
chk("存在等待者时 tryAcquire 拒绝插队（队列不会饿死工作流等待者）",
  steal === null, `steal=${steal === null ? "null（正确）" : "拿到许可（插队）"}`);
h3();
const gFair = await wFair; if (gFair) gFair();
lim.resetGlobalConcurrencyLimiter();

console.log("");
console.log("== REQ-006 取消完整性（自写探针，覆盖门禁未覆盖的分支）==");
const CANVAS = "c6-canvas";
const NODE = "c6-node";
function seedNode(canvasIdActive) {
  const data = { ...getDefaultImageGeneratorData(), prompt: "cancel probe" };
  useFlowStore.setState({ nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...data } }], edges: [] });
  useCanvasStore.setState({
    activeCanvasId: canvasIdActive,
    canvases: [
      { id: CANVAS, name: "c6", nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...data } }], edges: [] },
    ],
  });
}
function readProducts() {
  const f = useFlowStore.getState().nodes.find((n) => n.id === NODE);
  const d = (f && f.data) || {};
  return { status: d.status, out: d.outputImage, path: d.outputImagePath, paths: d.outputImagePaths, recs: d.runRecords };
}
async function cancelAt(stage, withRunRecords) {
  seedNode(CANVAS);
  globalThis.__NC_GATE__ = null; globalThis.__NC_GEN_ERROR__ = false; globalThis.__NC_GEN_EMPTY__ = false;
  const ctrl = new AbortController();
  if (stage === "provider") {
    let entered; const ent = new Promise((r) => { entered = r; });
    let release; const may = new Promise((r) => { release = r; });
    globalThis.__NC_GATE__ = { markEntered: entered, wait: may };
    const run = executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords, signal: ctrl.signal });
    await ent;
    ctrl.abort(); release();
    return { res: await run, after: readProducts() };
  }
  if (stage === "save") {
    let entered; const ent = new Promise((r) => { entered = r; });
    let release; const may = new Promise((r) => { release = r; });
    globalThis.__NC_SAVE_GATE__ = { markEntered: entered, wait: may };
    const run = executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords, signal: ctrl.signal });
    await ent;
    ctrl.abort(); release();
    const res = await run;
    delete globalThis.__NC_SAVE_GATE__;
    return { res, after: readProducts() };
  }
  throw new Error("unknown stage");
}

for (const wr of [false, true]) {
  const { res, after } = await cancelAt("provider", wr);
  const recs = after.recs || [];
  const hasSuccess = recs.some((r) => r.status === "success");
  chk(`取消落在 provider 返回窗口（withRunRecords=${wr}）→ cancelled、status!=success、无本次产物`,
    res.cancelled === true && after.status !== "success" && !after.out && !after.path && !(after.paths && after.paths.length) && !hasSuccess,
    `返回 cancelled=${res.cancelled} status=${JSON.stringify(after.status)} out=${JSON.stringify(after.out || null)} path=${JSON.stringify(after.path || null)} runRecords.success=${hasSuccess}`);
}
for (const wr of [false, true]) {
  const { res, after } = await cancelAt("save", wr);
  const recs = after.recs || [];
  const hasSuccess = recs.some((r) => r.status === "success");
  chk(`取消落在落盘窗口（withRunRecords=${wr}）→ 不写回成功`,
    res.cancelled === true && after.status !== "success" && !(after.paths && after.paths.length) && !hasSuccess,
    `返回 cancelled=${res.cancelled} status=${JSON.stringify(after.status)} paths=${JSON.stringify(after.paths || null)} runRecords.success=${hasSuccess}`);
}
// 无画布（canvasId=null）路径：base64 回退分支也必须被复查支配
{
  seedNode(CANVAS);
  const ctrl = new AbortController();
  globalThis.__NC_GATE__ = null;
  ctrl.abort();  // 预取消（无画布时无落盘窗口，验证早退复查）
  const res = await executeImageGeneration(NODE, { canvasId: null, withRunRecords: false, signal: ctrl.signal });
  const after = readProducts();
  chk("canvasId=null（base64 回退路径）+ 预取消 → 不写回成功产物",
    res.cancelled === true && after.status !== "success" && !after.out,
    `返回 cancelled=${res.cancelled} status=${JSON.stringify(after.status)}`);
}
// 对照：provider 报错时 runRecords 必须留下 error 记录（不能被一刀切丢弃）
{
  seedNode(CANVAS);
  globalThis.__NC_GATE__ = null; globalThis.__NC_GEN_ERROR__ = true;
  const ctrl = new AbortController();
  const res = await executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords: true, signal: ctrl.signal });
  const after = readProducts();
  const recs = after.recs || [];
  chk("对照组：provider 报 error（未取消）→ runRecords 正常留下 error 记录、status=error",
    res.success === false && after.status === "error" && recs.some((r) => r.status === "error"),
    `success=${res.success} status=${JSON.stringify(after.status)} 记录数=${recs.length} 末条=${JSON.stringify(recs[0] && recs[0].status)}`);
  globalThis.__NC_GEN_ERROR__ = false;
}
// 对照：provider 成功但无图片数据 → 必须写 error（改造前工作流路径会假成功）
{
  seedNode(CANVAS);
  globalThis.__NC_GATE__ = null; globalThis.__NC_GEN_EMPTY__ = true;
  const res = await executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords: false });
  const after = readProducts();
  chk("provider 成功但无图片数据 → 正确写 error（复用收益，非假成功）",
    res.success === false && after.status === "error",
    `success=${res.success} error=${JSON.stringify(res.error)} status=${JSON.stringify(after.status)}`);
  globalThis.__NC_GEN_EMPTY__ = false;
}

console.log("");
console.log("== 非活动画布：canvasStore 副本的 queued 标记 ==");
{
  const OTHER = "c6-other";
  const NODE2 = "c6-node2";
  const data = () => ({ ...getDefaultImageGeneratorData(), prompt: "p", queued: true });
  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
  // 先建立活动任务，再写节点数据（避免自愈把它当陈旧清掉）
  useQueueStore.setState({
    paused: true, concurrency: 1,
    jobs: [{ id: "j-other", nodeId: NODE2, canvasId: OTHER, nodeLabel: "O", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() }],
  });
  useFlowStore.setState({ nodes: [], edges: [] });
  useCanvasStore.setState({
    activeCanvasId: CANVAS,   // 活动画布 = 另一个；目标节点在 OTHER 画布上
    canvases: [
      { id: CANVAS, name: "c6", nodes: [], edges: [] },
      { id: OTHER, name: "other", nodes: [{ id: NODE2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }], edges: [] },
    ],
  });
  const otherCanvasPre = useCanvasStore.getState().canvases.find((c) => c.id === OTHER).nodes[0].data.queued;
  // 也把该节点放进 flowStore（模拟真实运行时活动画布仍是它自己的副本？—— 这里刻意只放在 canvasStore）
  const { nodeExecutor } = await import(pathToFileURL(path.join(SRC, "services/nodeExecutor.ts")).href);
  globalThis.__NC_GATE__ = null;
  await nodeExecutor.executeNode({ id: NODE2, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: data() }, OTHER);
  await new Promise((r) => setTimeout(r, 50));
  const otherCanvasPost = useCanvasStore.getState().canvases.find((c) => c.id === OTHER).nodes[0].data.queued;
  chk("工作流跑在**非活动画布**上时，canvasStore 副本的合法 queued 标记同样被保留",
    otherCanvasPre === true && otherCanvasPost === true,
    `前置=${JSON.stringify(otherCanvasPre)} 后置=${JSON.stringify(otherCanvasPost)}`);
  useQueueStore.setState({ jobs: [] });
}

lim.resetGlobalConcurrencyLimiter();
console.log("");
console.log("=".repeat(78));
console.log(`汇总：${fails === 0 ? "全部符合预期" : fails + " 项不符合预期"}`);
console.log("DONE");
