/**
 * 审查者探针 P-cancel-completeness（TASK-003 r1 独立审查用；只读）
 *
 * 攻击点（REQ-006 完整性）：枚举"provider 返回之后仍会写节点状态/落盘"的每一处，确认
 * 最后一次 abort 复查是否支配它们，并且 withRunRecords 的两种取值都查：
 *   C1 withRunRecords=true（手动/队列路径）：取消落在落盘窗口时，节点不得出现 success 与本次产物，
 *      且 runRecords 里**不得**留下 status:"success" 的记录（用例 H 用的是 false，这条没被门禁覆盖）
 *   C2 withRunRecords=false（工作流路径）：同场景（用例 H 覆盖的情形）
 *   C3 取消点更靠后（落盘已开始、Promise.all(saveImage) 进行中）：仍不得写回 success
 *   C4 非取消的失败路径不受影响：provider 报错时 runRecords 必须留下 error 记录（对照，防"一刀切不写"）
 *
 * 运行：node --experimental-strip-types <this>
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const root = process.cwd();
const SRC = path.join(root, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.__NC_STORE_SEED__ = {};

const STUBS = {
  "@xyflow/react": `export default {};export const ReactFlow=()=>null;export const Background=()=>null;export const Controls=()=>null;
    export const MiniMap=()=>null;export const Panel=()=>null;export const Handle=()=>null;export const useReactFlow=()=>({});
    export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;export const addEdge=(e,es)=>es;
    export const MarkerType={};export const Position={};export const ConnectionLineType={};export const SelectionMode={};
    export const useStore=()=>({});export const getBezierPath=()=>["","",0,0];export const BaseEdge=()=>null;
    export const EdgeLabelRenderer=()=>null;export const useNodes=()=>[];export const useEdges=()=>[];`,
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
const imageGenUrl = "mutant:probe-imagegen";
const fsUrl = "mutant:probe-fs";
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGeneration") return { url: imageGenUrl, shortCircuit: true };
    if (spec === "@/services/fileStorageService") return { url: fsUrl, shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === imageGenUrl) {
      const real = JSON.stringify(pathToFileURL(path.join(SRC, "services/imageGeneration/index.ts")).href);
      return {
        format: "module", shortCircuit: true,
        source: `
          import { generateImage as rg, editImage as re } from ${real};
          export * from ${real};
          const cfg = () => globalThis.__C__ || {};
          export const generateImage = async (...a) =>
            cfg().behaviour === "error" ? { error: "probe: provider error", errorDetails: { code: "E" } }
            : { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="], text: "ok" };
          export const editImage = async (...a) => generateImage(...a);
        `,
      };
    }
    if (url === fsUrl) {
      const real = JSON.stringify(pathToFileURL(path.join(SRC, "services/fileStorageService.ts")).href);
      return {
        format: "module", shortCircuit: true,
        source: `
          import { saveImage as realSaveImage } from ${real};
          export * from ${real};
          export async function saveImage(...args) {
            const gate = globalThis.__GATE__;
            if (!gate) return realSaveImage(...args);
            return gate(() => realSaveImage(...args));
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const { executeImageGeneration } = await import(pathToFileURL(path.join(SRC, "services/imageGenerationExecution.ts")).href);

const CANVAS = "cc-canvas";
const NODE = "cc-node";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok: Boolean(ok), detail }); console.log(`${ok ? "OK  " : "VIOL"}  ${id}  ${detail}`); };

function seed() {
  const n = { id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...getDefaultImageGeneratorData(), prompt: "cc", model: "gemini-2.5-flash-image" } };
  useFlowStore.setState({ nodes: [n], edges: [] });
  useCanvasStore.setState({ activeCanvasId: CANVAS, canvases: [{ id: CANVAS, name: "cc", nodes: [JSON.parse(JSON.stringify(n))], edges: [] }] });
}
function snap() {
  const d = (useFlowStore.getState().nodes.find((x) => x.id === NODE) || {}).data || {};
  return {
    status: d.status ?? null,
    outputImage: d.outputImage ?? null,
    outputImagePath: d.outputImagePath ?? null,
    outputImages: d.outputImages ?? null,
    outputImagePaths: d.outputImagePaths ?? null,
    records: (d.runRecords || []).map((r) => ({ status: r.status, error: r.error ?? null, hasOutput: Boolean(r.output) })),
  };
}

/**
 * 取消落在"落盘进行中"的窗口：saveImage 进入后等放行。
 *   abortMode="during"  → 放行**之前** abort（取消落在落盘 await 中间；门禁用例 H 的形状）
 *   abortMode="atTail"  → 真实 saveImage 已跑完、但 promise 尚未 resolve 给调用方时就 abort
 *                         （精确检验"最后一个 await 的尾部"这一边界）
 *   abortMode="after"   → 整个执行已写完 success 之后才 abort（取消迟到；语义上应当无效）
 */
async function runCancel({ withRunRecords, abortMode = "during", behaviour = "ok", fakeSaveOk = false }) {
  globalThis.__C__ = { behaviour, fakeSaveOk };
  seed();
  let enteredResolve; const entered = new Promise((r) => (enteredResolve = r));
  let goResolve; const go = new Promise((r) => (goResolve = r));
  let enteredCount = 0;
  const ctrl = new AbortController();
  globalThis.__GATE__ = async (fn) => {
    enteredCount += 1;
    enteredResolve();
    await go;
    // fakeSaveOk：不调用真实的 saveImage（本门禁里 Tauri invoke 被 stub 成抛错），
    // 直接返回一个"落盘成功"的 ImageInfo，从而把"图片真的已经写到磁盘"这一最坏情形做出来。
    // 这样下面的 atTail 才能测到"落盘已成功、结果尚未写回"这个精确窗口。
    let r;
    try {
      r = globalThis.__C__?.fakeSaveOk
        ? { id: "fake", filename: "fake.png", path: "/fake/fake.png", size: 1, created_at: Date.now(), thumb_path: "/fake/fake_thumb.jpg" }
        : await fn();
    } finally {
      // atTail：落盘已结束（成功或失败），但本 promise 还没 resolve 回 executeImageGeneration，
      // 也就是"abort 恰好落在最后一个 await 的尾部"。必须放 finally：
      // 若放 try 尾部，saveImage 抛错时这行会被跳过（旧版探针正是这样失效的）。
      if (abortMode === "atTail") ctrl.abort();
    }
    return r;
  };
  try {
    const p = executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords, signal: ctrl.signal });
    const opened = await Promise.race([entered.then(() => true), sleep(5000).then(() => false)]);
    if (!opened) { goResolve(); await p.catch(() => {}); return { opened: false }; }
    if (abortMode === "during") ctrl.abort();
    goResolve();
    if (abortMode === "after") { await sleep(60); ctrl.abort(); }
    const result = await p;
    return { opened: true, enteredCount, result, node: snap() };
  } finally {
    delete globalThis.__GATE__;
    delete globalThis.__C__;
  }
}

// --- C1 withRunRecords=true（手动/队列路径）取消落在落盘窗口 ------------------
{
  const r = await runCancel({ withRunRecords: true });
  const ok = r.opened && r.result.cancelled === true && r.node.status !== "success" &&
    !r.node.outputImage && !r.node.outputImagePath && !r.node.outputImages && !r.node.outputImagePaths &&
    !r.node.records.some((x) => x.status === "success");
  check("C1-queue-path-cancel-no-success", ok,
    `withRunRecords=true：落盘窗口=${r.opened}，返回 cancelled=${String(r.result.cancelled)}；` +
    `节点 status=${JSON.stringify(r.node.status)}、产物=${JSON.stringify([r.node.outputImage, r.node.outputImagePath, r.node.outputImages, r.node.outputImagePaths])}；` +
    `runRecords=${JSON.stringify(r.node.records)}（不得有 status:"success"）`);
}

// --- C2 withRunRecords=false（工作流路径）同场景 -----------------------------
{
  const r = await runCancel({ withRunRecords: false });
  const ok = r.opened && r.result.cancelled === true && r.node.status !== "success" &&
    !r.node.outputImage && !r.node.outputImagePath && !r.node.outputImagePaths;
  check("C2-workflow-path-cancel-no-success", ok,
    `withRunRecords=false：落盘窗口=${r.opened}，返回 cancelled=${String(r.result.cancelled)}；节点 status=${JSON.stringify(r.node.status)}、产物均为空=${!r.node.outputImage && !r.node.outputImagePath && !r.node.outputImagePaths}`);
}

// --- C3 取消落在"最后一个 await 的尾部"（落盘已成功、结果尚未写回）------------
{
  const r = await runCancel({ withRunRecords: true, abortMode: "atTail", fakeSaveOk: true });
  const ok = r.opened && r.result.cancelled === true && r.node.status !== "success" &&
    !r.node.outputImage && !r.node.outputImagePath && !r.node.outputImagePaths &&
    !r.node.records.some((x) => x.status === "success");
  check("C3-tail-cancel-no-success", ok,
    `落盘已成功、abort 落在紧跟其后的同步区间（最后一个 await 的尾部）：返回 cancelled=${String(r.result.cancelled)}、success=${String(r.result.success)}；` +
    `节点 status=${JSON.stringify(r.node.status)}、产物=${JSON.stringify([r.node.outputImage, r.node.outputImagePath, r.node.outputImagePaths])}；runRecords=${JSON.stringify(r.node.records)}`);
}

// --- C3b 取消迟到（执行已写完 success）：语义上本就不该回滚，只记录现状 --------
{
  const r = await runCancel({ withRunRecords: true, abortMode: "after" });
  check("C3b-late-cancel-observation", r.opened && r.node.status === "success",
    `【观察项，非缺陷】执行器已把 status:"success" 与产物写完（用户此时才点取消）时，结果保持成功：` +
    `返回 success=${String(r.result.success)}、节点 status=${JSON.stringify(r.node.status)}。` +
    `这符合文件头声明的口径——只保证"取消后不写回"，不宣称撤回已写回的结果；` +
    `真实场景下队列取消走 abortControllers，任务状态已在 pump 里落终态，不回滚节点属于既有语义。`);
}

// --- C4 对照：非取消的 provider 报错仍必须留下 error 记录 --------------------
{
  globalThis.__C__ = { behaviour: "error" };
  seed();
  let result, node;
  try {
    result = await executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords: true });
    node = snap();
  } finally { delete globalThis.__C__; }
  const ok = result.success === false && node.status === "error" && node.records.some((x) => x.status === "error");
  check("C4-control-error-path-records", ok,
    `provider 报错：success=${result.success} error=${JSON.stringify(result.error)}；节点 status=${JSON.stringify(node.status)}；runRecords=${JSON.stringify(node.records)}（必须留下 error 记录，证明"取消复查"没有把正常失败路径一起吞掉）`);
}

const violated = results.filter((r) => !r.ok);
console.log("");
console.log(`P-cancel-completeness 汇总：${results.length - violated.length}/${results.length} 条断言成立`);
if (violated.length > 0) console.log("未成立的断言：" + violated.map((v) => v.id).join(", "));
process.exitCode = violated.length > 0 ? 1 : 0;
console.log(`EXIT CODE: ${process.exitCode}`);
