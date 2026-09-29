/**
 * 独立审查探针 R6-G（round 6, PRIORITY 1 #3）：延后循环在**正常路径**上到底跑几轮？
 *
 * 注释 :883 称「没有就退出（正常路径只跑一轮，F-R3-2 不受影响）」。
 * 但治疗自身的清除写入也会同步触发本订阅，而那一刻 `healingQueuedMarkers === true`
 * → 必然置位 `healPending` → 收尾检查不会 break。
 *
 * 本探针用插桩副本（%TEMP% 内）精确计数「一次 heal 的 for(;;) 迭代次数」：
 *   · 场景 A：1 个候选、无任何外部写入方 → 期望 1 轮（注释的声明）
 *   · 场景 B：同场景但记录身份变化次数（验证第二轮是否零写入）
 * 用法：R6_QS=<instrumented queueStore> node --experimental-strip-types r6-heal-iters.mjs
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
if (!QS || !existsSync(QS)) { console.error("需要 R6_QS 指向插桩副本"); process.exit(2); }

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
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (!spec.startsWith(".") && !spec.startsWith("node:") && !spec.startsWith("file:")) {
      try {
        const resolved = createRequire(path.join(REPO, "package.json")).resolve(spec);
        return { url: pathToFileURL(resolved).href, shortCircuit: true };
      } catch { /* fallthrough */ }
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
const { createRequire } = await import("node:module");
const { useQueueStore } = await import(pathToFileURL(QS).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const mk = (id, queued) => ({
  id, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L", ...(queued === undefined ? {} : { queued }) },
});
const marker = (id) => useFlowStore.getState().nodes.find((n) => n.id === id)?.data?.queued;

// 场景 A：1 个候选、无外部写入方
useQueueStore.setState({ jobs: [], paused: true, concurrency: 1 });
useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk(X, false)], edges: [] }], activeCanvasId: A, _hasHydrated: true });
useFlowStore.setState({ nodes: [mk(X, false)], edges: [], history: [], historyIndex: -1 });
await sleep(20);

let identityChanges = 0;
const unsub = useFlowStore.subscribe((s, p) => { if (s.nodes !== p.nodes) identityChanges++; });

globalThis.__HEAL_ITERS__ = 0;
identityChanges = 0;
const trigger = [mk(X, true)];
useFlowStore.setState({ nodes: trigger });   // 触发 heal（同步完成）
const iters = globalThis.__HEAL_ITERS__;
const syncChanges = identityChanges;
await sleep(30);
unsub();

console.log("========== 正常路径：1 个候选、无外部写入方 ==========");
console.log(`  触发后：X=${JSON.stringify(marker(X))}`);
console.log(`  for(;;) 迭代次数 = ${iters}   ← 注释 :883 声称「正常路径只跑一轮」`);
console.log(`  同步栈内身份变化次数 = ${syncChanges}（其中 1 次是触发本身）`);
console.log(`  ⇒ 是否只跑一轮：${iters === 1 ? "是" : `否（跑了 ${iters} 轮）`}`);
console.log("");
console.log("  机制解释：第 1 轮里 clearNodeQueuedMarkerIfNoActiveJob(X) → flowStore.updateNodeData → set(nodes)");
console.log("            同步通知本订阅 → 此刻 healingQueuedMarkers===true → 置位 healPending；");
console.log("            收尾 `if (!healPending) break;` 因此不 break → 第 2 轮用最新 nodes 重取候选（此时为空）→ break。");
console.log("  ⇒ 即：**治疗自身的写入**就会置位 healPending，所以「没有（第三方）嵌套通知就退出」这一论证");
console.log("     对正常路径并不成立；好在第 2 轮候选为空、零写入（实测同步栈只有 1 次身份变化）。");

// 场景 B：候选为空 → 早退，零迭代
globalThis.__HEAL_ITERS__ = 0;
const trigger2 = [mk(X, false)];
useFlowStore.setState({ nodes: trigger2 });
const iters2 = globalThis.__HEAL_ITERS__;
console.log("");
console.log("========== 对照：标记本就 falsy（候选为空）==========");
console.log(`  for(;;) 迭代次数 = ${iters2}（期望 0：在置位重入标志之前早退）`);
console.log(`  传入数组是否被替换 = ${useFlowStore.getState().nodes !== trigger2}（期望 false）`);
process.exitCode = (iters === 1 && iters2 === 0) ? 0 : 1;
