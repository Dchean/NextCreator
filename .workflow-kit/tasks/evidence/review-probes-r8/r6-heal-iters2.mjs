/**
 * 独立审查探针 R6-G2（round 6, PRIORITY 1 #3）：延后机制在**正常路径**上的真实代价。
 *
 * 用插桩副本精确计数三件事：
 *   · __HEAL_PASS__：for(;;) 体执行次数（真的跑了第 2 轮吗？）
 *   · __HEAL_DEFER__：嵌套通知被延后的次数（谁置位了 healPending？）
 *   · __HEAL_PRED__：唯一谓词 clearNodeQueuedMarkerIfNoActiveJob 被调用次数
 *
 * 场景 A：1 个候选、无任何第三方写入方（= 注释所称的"正常路径"）
 * 场景 B：候选为空
 * 用法：R6_QS=<instrumented> node --experimental-strip-types r6-heal-iters2.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const X = "gen-x";
const A = "canvas-a";
const QS = process.env.R6_QS;
if (!QS || !existsSync(QS)) { console.error("需要 R6_QS"); process.exit(2); }

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
const { createRequire } = await import("node:module");
const reqRepo = createRequire(path.join(REPO, "package.json"));
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (!spec.startsWith(".") && !spec.startsWith("node:") && !spec.startsWith("file:") && !spec.startsWith("stub:") && !spec.startsWith("mutant:")) {
      try { return { url: pathToFileURL(reqRepo.resolve(spec)).href, shortCircuit: true }; } catch { /* fallthrough */ }
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

const mk = (queued) => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L", ...(queued === undefined ? {} : { queued }) },
});
const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const reset = () => { globalThis.__HEAL_PASS__ = 0; globalThis.__HEAL_DEFER__ = 0; globalThis.__HEAL_PRED__ = 0; };

useQueueStore.setState({ jobs: [], paused: true, concurrency: 1 });
useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk(false)], edges: [] }], activeCanvasId: A, _hasHydrated: true });
useFlowStore.setState({ nodes: [mk(false)], edges: [], history: [], historyIndex: -1 });
await sleep(20);

console.log("========== 场景 A：1 个候选、无第三方写入方（注释所称『正常路径』）==========");
reset();
let identityChanges = 0;
const unsub = useFlowStore.subscribe((s, p) => { if (s.nodes !== p.nodes) identityChanges++; });
useFlowStore.setState({ nodes: [mk(true)] });   // 触发（同步跑完 heal）
const sync = { pass: globalThis.__HEAL_PASS__, defer: globalThis.__HEAL_DEFER__, pred: globalThis.__HEAL_PRED__, idc: identityChanges };
await sleep(40);
unsub();
console.log(`  标记=${JSON.stringify(marker())}`);
console.log(`  for(;;) 体执行次数 = ${sync.pass}    ← 注释 :884 称「正常路径只跑一轮」`);
console.log(`  嵌套通知被延后次数 = ${sync.defer}  ← 注释 :833-838 的终止论证只承认「确有嵌套通知」时才再跑一轮`);
console.log(`  唯一谓词被调用次数 = ${sync.pred}`);
console.log(`  身份变化次数 = ${sync.idc}（其中 1 次是触发本身）`);
console.log("");
if (sync.pass === 1 && sync.defer === 0) {
  console.log(`  ⇒ 与注释一致：只跑一轮，且没有任何嵌套通知被延后。`);
} else {
  console.log(`  ⇒ 与注释**不一致**：healPending 被置位 ${sync.defer} 次（第 ${sync.pass} 轮因此得以发生）。`);
  console.log(`     置位者不是第三方订阅者，而是【治疗自身的写入】：clearNodeQueuedMarkerIfNoActiveJob`);
  console.log(`     → flowStore.updateNodeData → set(nodes) → 同步通知本订阅 → 此刻 healingQueuedMarkers===true`);
  console.log(`     → 必然 healPending=true。故「没有新通知 → healPending 保持 false → 退出」对正常路径不成立；`);
  console.log(`     实际是「第 2 轮候选为空才退出」。`);
  console.log(`     F-R3-2 的**可观测**性质未被破坏：第 2 轮零写入（身份变化次数仍只有触发那 1 次）。`);
}

console.log("");
console.log("========== 场景 B：候选为空（标记本就 falsy）==========");
reset();
const trigger = [mk(false)];
const idcBefore = identityChanges;
useFlowStore.setState({ nodes: trigger });
console.log(`  for(;;) 体执行次数 = ${globalThis.__HEAL_PASS__}（期望 0）`);
console.log(`  嵌套通知被延后次数 = ${globalThis.__HEAL_DEFER__}（期望 0）`);
console.log(`  传入数组是否被替换 = ${useFlowStore.getState().nodes !== trigger}（期望 false ⇒ 零写入、零身份变化）`);
