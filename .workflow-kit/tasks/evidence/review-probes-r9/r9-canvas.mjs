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
  s = s.replace("      if (!healPending) break;", "      if (!healPending) { globalThis.__R8_EXIT__ = 'nopending'; break; }");
  s = s.replace("      if (candidates.length === 0) break;", "      if (candidates.length === 0) { globalThis.__R8_EXIT__ = 'zero'; break; }");
  s = s.replace("      if (passes >= MAX_HEAL_PASSES) {", "      if (passes >= MAX_HEAL_PASSES) { globalThis.__R8_EXIT__ = 'cap';");
  s = s.replace(
    "        const stillClearable = candidates.filter(",
    "        globalThis.__R9_ALLTRUE__ = useFlowStore.getState().nodes.filter((n) => n.data?.queued === true).length;" +
      "globalThis.__R9_TRUTH__ = useFlowStore.getState().nodes.filter((n) => n.data?.queued === true && !useQueueStore.getState().jobs.some((j) => j.nodeId === n.id && (j.status === 'queued' || j.status === 'running'))).length;" +
      "globalThis.__R9_PASSES__ = passes;" +
      "        const stillClearable = candidates.filter("
  );
  s = s.replace(
    "  const hasActiveJob = jobs.some((job) => job.nodeId === nodeId && isActiveJob(job));",
    "  globalThis.__R7_PRED__ = (globalThis.__R7_PRED__ || 0) + 1;\n  const hasActiveJob = jobs.some((job) => job.nodeId === nodeId && isActiveJob(job));"
  );
  if (s === before) throw new Error("插桩锚点未命中：源码结构已变，探针失效（不是候选缺陷）");
  const nPass = (s.match(/globalThis\.__R7_PASSES__ = passes;/g) || []).length;
  const nPred = (s.match(/globalThis\.__R7_PRED__ = \(globalThis\.__R7_PRED__ \|\| 0\) \+ 1;/g) || []).length;
  const nExit = (s.match(/__R8_EXIT__ = '/g) || []).length;
  if (nPass !== 1 || nPred !== 1 || nExit !== 3) throw new Error(`插桩锚点计数异常 pass=${nPass} pred=${nPred} exit=${nExit}，探针失效`);
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
const reset = () => { globalThis.__R7_PASSES__ = 0; globalThis.__R7_PRED__ = 0; globalThis.__R8_EXIT__ = undefined; };

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`); };
function seed({ flowNodes, jobs = [] }) {
  useQueueStore.setState({ jobs, paused: true, concurrency: 1 });
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: flowNodes.map((n) => mk(n.id, n.data?.queued)), edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: flowNodes, edges: [], history: [], historyIndex: -1 });
}

// R9 probe: can the new stillClearable gate MISS a stale marker that lives only on the
// persisted canvasStore copy? (PRIMARY concern #1)
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const L = "gen-legal";
let bad = 0;
const ck = (ok, label) => { if (!ok) bad++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`); };

const qsMod = await import(pathToFileURL(QS).href);
console.log(`module source: ${LABEL}`);
console.log(`single instance: ${qsMod.useQueueStore === useQueueStore}`);
console.log("");

const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(" "));
const setCanvas = (nodes) => useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes, edges: [] }], activeCanvasId: A, _hasHydrated: true });

// H1: the gate's own truth criterion, computed the same way the code does.
// Question: if the ONLY stale true lives on the canvasStore copy (flowStore already false),
// can the cap branch be reached with a stale marker remaining while stillClearable === 0?
console.log("H1: cap reached with a stale true ONLY on the persisted canvas copy");
{
  warnings.length = 0;
  seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
  await sleepMs(10);
  reset();
  warnings.length = 0;
  // canvas copy of X is stale true; flowStore copy of X is false
  setCanvas([mk(X, true), mk(L, true)]);
  // unbounded pathological writer keeps re-arming flowStore's X -> forces the cap
  let w = 0;
  const unsub = useFlowStore.subscribe(() => {
    const t = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
    if (t) return;
    w++;
    if (w > 50) return;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
  const st = { passes: globalThis.__R7_PASSES__, exit: globalThis.__R8_EXIT__, truth: globalThis.__R9_TRUTH__ };
  await sleepMs(10);
  unsub();
  const xF = marker(X), cF = canvasMarker(X);
  console.log(`  exit=${st.exit} passes=${st.passes} flowStore X=${xF} canvas X=${cF} warns=${warnings.length} gateTruth(at cap)=${st.truth}`);
  ck(st.truth >= 1, "at the cap, the gate's own criterion is >=1 whenever flowStore still holds a stale true");
  ck(xF === true, "pathological writer keeps flowStore X true (cap path)");
  ck(warnings.length === 1, "warning fires on this path (diagnostic alive)");
}

// H2: the decisive question -- cap reached, flowStore's stale true healed, canvas copy still stale.
// Can this happen? The gate scans flowStore only. Show what actually occurs.
console.log("");
console.log("H2: bounded writer; after the cap, is flowStore's X healed while canvas X is still true?");
{
  warnings.length = 0;
  seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
  await sleepMs(10);
  reset();
  warnings.length = 0;
  setCanvas([mk(X, true), mk(L, true)]);
  let w = 0;
  const unsub = useFlowStore.subscribe(() => {
    const t = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
    if (t) return;
    w++;
    if (w > 12) return;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
  const st = { passes: globalThis.__R7_PASSES__, exit: globalThis.__R8_EXIT__, truth: globalThis.__R9_TRUTH__ };
  await sleepMs(10);
  unsub();
  const xF = marker(X), cF = canvasMarker(X);
  console.log(`  exit=${st.exit} flowStore X=${xF} canvas X=${cF} warns=${warnings.length} gateTruth=${st.truth}`);
  // The gate reads flowStore. If flowStore X is already false at the cap moment, gateTruth would be 0.
  ck(!(st.exit === "cap" && xF === false && st.truth === 0 && warnings.length === 1),
     "no spurious warning: whenever the warning fires, flowStore still holds a clearable stale marker");
}

// H3: positive control -- force gateTruth to 0 at the cap and confirm no warning is printed
// (i.e. the gate genuinely suppresses, and ask whether that suppression could hide a canvas-only stale).
console.log("");
console.log("H3: does a canvas-only stale true EVER reach the cap with flowStore already clean?");
{
  let hit = 0;
  for (let arm = 8; arm <= 14; arm++) {
    warnings.length = 0;
    seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
    await sleepMs(6);
    reset();
    warnings.length = 0;
    setCanvas([mk(X, true), mk(L, true)]);
    let w = 0;
    const unsub = useFlowStore.subscribe(() => {
      const t = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
      if (t) return;
      w++; if (w > arm) return;
      useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
    });
    useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
    const st = { exit: globalThis.__R8_EXIT__, truth: globalThis.__R9_TRUTH__ };
    await sleepMs(6);
    unsub();
    const xF = marker(X), cF = canvasMarker(X), wn = warnings.length;
    const shape = st.exit === "cap" && xF === false && cF === true;
    if (shape) hit++;
    console.log(`  arm=${String(arm).padStart(2)} exit=${String(st.exit).padStart(9)} flowX=${String(xF).padStart(5)} canvasX=${String(cF).padStart(5)} warns=${wn} gateTruth=${st.truth}${shape ? "  <-- cap with canvas-only stale" : ""}`);
  }
  ck(hit === 0, "no arm produces 'cap + flowStore clean + canvas still stale' (gate cannot miss that way)");
}

console.warn = origWarn;
console.log("");
console.log(`RESULT: ${bad === 0 ? "gate cannot miss a canvas-only stale marker on the cap path" : `${bad} assertion(s) failed`}`);
process.exitCode = bad === 0 ? 0 : 1;
