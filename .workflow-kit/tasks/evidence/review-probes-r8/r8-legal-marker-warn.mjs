/**
 * 独立审查探针 R7-A（round 7）：自愈循环的上限 MAX_HEAL_PASSES 的终止性/必要性/代价。
 * 用法：
 *   node --experimental-strip-types r7-cap.mjs                       # 真实候选（插桩副本）
 *   set R7_QS=<path> && node ... r7-cap.mjs                          # 指定 queueStore 副本
 * 插桩：R7_INSTR=1 时用 %TEMP% 的插桩副本（仅在 passes/predicate 处注入 globalThis 计数，行为不变）
 */
import { registerHooks, createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const REAL = path.join(SRC, "stores/queueStore.ts");
const TMP = path.join(process.env.TEMP, "r7review");
const X = "gen-x";
const A = "canvas-a";

// —— 生成插桩副本 / 无上限突变体 ——
const realSrc = readFileSync(REAL, "utf8");
function instrument(src) {
  let s = src;
  const before = s;
  s = s.replace("      passes += 1;", "      passes += 1; globalThis.__R7_PASSES__ = passes;");
  s = s.replace(
    "  const hasActiveJob = jobs.some((job) => job.nodeId === nodeId && isActiveJob(job));",
    "  globalThis.__R7_PRED__ = (globalThis.__R7_PRED__ || 0) + 1;\n  const hasActiveJob = jobs.some((job) => job.nodeId === nodeId && isActiveJob(job));"
  );
  if (s === before) throw new Error("插桩锚点未命中：源码结构已变，探针失效（不是候选缺陷）");
  const nPass = (s.match(/globalThis\.__R7_PASSES__ = passes;/g) || []).length;
  const nPred = (s.match(/globalThis\.__R7_PRED__ = \(globalThis\.__R7_PRED__ \|\| 0\) \+ 1;/g) || []).length;
  if (nPass !== 1 || nPred !== 1) throw new Error(`插桩锚点计数异常 pass=${nPass} pred=${nPred}，探针失效`);
  return s;
}
const INST = path.join(TMP, "qs-inst.ts");
writeFileSync(INST, instrument(realSrc), "utf8");
const NOCAP = path.join(TMP, "qs-nocap.ts");
writeFileSync(NOCAP, instrument(realSrc).replace("const MAX_HEAL_PASSES = 8;", "const MAX_HEAL_PASSES = Number.POSITIVE_INFINITY;"), "utf8");
const NOCAP_OK = readFileSync(NOCAP, "utf8").includes("Number.POSITIVE_INFINITY") &&
  readFileSync(NOCAP, "utf8").includes("__R7_PASSES__");

const QS = process.env.R7_QS && existsSync(process.env.R7_QS) ? process.env.R7_QS : INST;
const LABEL = QS === INST ? "真实候选（插桩副本）" : QS === NOCAP ? "突变体（MAX_HEAL_PASSES=∞）" : QS;

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
const SILENT = `
export const executeImageGeneration = async () => ({ success: true, cancelled: false });
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);
`;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec", shortCircuit: true };
    // 关键：强制全仓库只有**一份** queueStore 实例（否则 @/stores/queueStore 会解析到真实源码，
    // 出现两个实例、两条 heal 订阅、两份 jobs —— 突变体实验会被真实实例的上限污染）
    if (spec === "@/stores/queueStore" || spec === "../stores/queueStore" || spec === "./queueStore")
      return { url: pathToFileURL(QS).href, shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (!spec.startsWith(".") && !spec.startsWith("node:") && !spec.startsWith("file:")) {
      try {
        const resolved = createRequire(path.join(REPO, "package.json")).resolve(spec);
        return { url: pathToFileURL(resolved).href, shortCircuit: true };
      } catch { /* 交给默认解析 */ }
    }
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec") return { format: "module", source: SILENT, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { useQueueStore } = await import(pathToFileURL(QS).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const D = () => ({ ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" });
const mk = (id, queued) => ({
  id, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...D(), ...(queued === undefined ? {} : { queued }) },
});
const marker = (id) => useFlowStore.getState().nodes.find((n) => n.id === id)?.data?.queued;
const canvasMarker = (id) => useCanvasStore.getState().canvases.find((c) => c.id === A)?.nodes.find((n) => n.id === id)?.data?.queued;
const job = (id, nodeId, status) => ({ id, nodeId, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", status, createdAt: Date.now() });
const reset = () => { globalThis.__R7_PASSES__ = 0; globalThis.__R7_PRED__ = 0; };

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`); };
function seed({ flowNodes, jobs = [] }) {
  useQueueStore.setState({ jobs, paused: true, concurrency: 1 });
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: flowNodes.map((n) => mk(n.id, n.data?.queued)), edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: flowNodes, edges: [], history: [], historyIndex: -1 });
}


const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const LEGAL = "gen-legal";
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(" ")); };
console.log("场景：LEGAL=合法标记（真有 queued 任务，谓词永不清它）；X=陈旧标记（写入方补 ARM 次即停）");
console.log("ARM | 轮数 | 出口      | X 最终 | 警告数 | :979「仍有陈旧标记未复核」是否成立");
let suspect = 0;
for (const ARM of [1, 2, 3, 5, 6, 7, 8]) {
  warnings.length = 0;
  seed({ flowNodes: [mk(X, false), mk(LEGAL, false)], jobs: [job("jL", LEGAL, "queued")] });
  await sleepMs(15);
  reset();
  warnings.length = 0;
  let wWrites = 0;
  const unsubW = useFlowStore.subscribe(() => {
    const xTrue = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
    if (xTrue) return;
    wWrites++;
    if (wWrites > ARM) return;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  useFlowStore.setState({ nodes: [mk(X, true), mk(LEGAL, true)] });
  const passes = globalThis.__R7_PASSES__;
  const exit = globalThis.__R8_EXIT__;
  const warns = warnings.length;
  const xFinal = marker(X);
  const legalFinal = marker(LEGAL);
  await sleepMs(20);
  unsubW();
  const claimHolds = xFinal === true;
  if (!claimHolds && warns > 0) suspect++;
  console.log(
    `${String(ARM).padStart(3)} | ${String(passes).padStart(4)} | ${String(exit).padStart(9)} | ${String(xFinal).padStart(6)} | ${String(warns).padStart(6)} | ${claimHolds ? "成立" : "★ 不成立：X 已治愈，剩余候选只有合法标记"}  (LEGAL=${legalFinal}, W写入=${wWrites})`
  );
}
console.warn = origWarn;
console.log("");
console.log(`RESULT: ${suspect === 0 ? "上限告警措辞在所有臂上均成立" : `★ ${suspect} 个臂上发出误报警告（X 已治愈却称未复核）`}`);
process.exitCode = suspect === 0 ? 0 : 1;
