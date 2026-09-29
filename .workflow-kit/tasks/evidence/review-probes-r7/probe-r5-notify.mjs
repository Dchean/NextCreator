/**
 * 审查探针（第 5 轮 · 独立审查者 · 第七发）：自愈在 flowStore 的通知回调里写
 * canvasStore.setState —— 订阅者（含 useSyncExternalStore 形态的组件）是否真的被通知？
 * 若通知丢失，画布订阅方会看到陈旧 UI（React 不会重渲染）。
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
const SILENT = `
export const executeImageGeneration = async () => ({ success: true, cancelled: false });
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
    if (url === "mutant:exec") return { format: "module", source: SILENT, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);

const X = "gen-x";
const A = "canvas-a";
const mk = (queued) => ({ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { prompt: "p", n: 1, status: "idle", label: "L", queued } });
const canvasMarker = () => useCanvasStore.getState().canvases.find((c) => c.id === A)?.nodes.find((n) => n.id === X)?.data?.queued;
const flowMarker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;

console.log("========== A) 自愈写 canvasStore 时，canvasStore 订阅者是否收到通知 ==========");
{
  useQueueStore.setState({ jobs: [], paused: true, concurrency: 1 });
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk(true)], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: [mk(false)], edges: [] });   // flow 已是 false，仅画布为 true

  let notices = 0;
  const lastCanvasRef = { v: useCanvasStore.getState().canvases };
  const unsub = useCanvasStore.subscribe((s) => { notices++; lastCanvasRef.v = s.canvases; });
  const before = useCanvasStore.getState().canvases;
  console.log(`  触发前：canvas[A].queued=${JSON.stringify(canvasMarker())}`);

  // 触发自愈：只要 nodes 换身份且存在候选（flow 里没有 true 就不构成候选！）
  // 注意：候选来自 flowStore.nodes —— 这里 flow 是 false，故主动制造一个候选节点再把它清掉
  useFlowStore.setState({ nodes: [mk(true)] });   // 候选出现；自愈会清 flow + canvas
  await sleep(20);
  unsub();
  console.log(`  触发后：canvas[A].queued=${JSON.stringify(canvasMarker())} canvasStore 通知次数=${notices} 身份变化=${before !== useCanvasStore.getState().canvases}`);
  console.log(`  通知回调里看到的 canvases 身份是否最新=${lastCanvasRef.v === useCanvasStore.getState().canvases}`);
  console.log(`  ⇒ ${canvasMarker() !== true ? "画布标记确实被清（写入落地）" : "未清"}；${notices > 0 ? "订阅者收到通知（React 会重渲染）" : "！！订阅者未收到通知（画布 UI 可能不更新）"}`);
}

console.log("");
console.log("========== B) 复核：同一次自愈里，画布标记只存在于副本（flow 无该节点）时能否被清 ==========");
{
  useQueueStore.setState({ jobs: [], paused: true, concurrency: 1 });
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk(true)], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: [mk(false)], edges: [] });
  let notices = 0;
  const unsub = useCanvasStore.subscribe(() => notices++);
  // 触发自愈需要一个 flowStore 候选；用另一个节点触发，然后看副本是否被顺带清（它不在候选里）
  useFlowStore.setState({ nodes: [{ ...mk(false), id: "other", data: { ...mk(false).data, queued: true } }] });
  await sleep(20);
  unsub();
  console.log(`  用节点 other 触发自愈后：canvas[A].queued=${JSON.stringify(canvasMarker())}（X 不是候选）通知次数=${notices}`);
  console.log(`  ⇒ ${canvasMarker() === true ? "副本上的陈旧 true 存活（自愈只处理 flowStore 里的候选）——与注释中\"画布副本不会成为漏网的一份\"存在张力" : "被清"}`);
}

console.log("");
console.log("========== C) 用户可见性：该副本被载入 flowStore（切画布）时是否自愈 ==========");
{
  const bNodes = useCanvasStore.getState().canvases.find((c) => c.id === A).nodes;
  useFlowStore.setState({ nodes: bNodes });
  await sleep(20);
  console.log(`  setNodes 同构载入后：flowStore=${JSON.stringify(flowMarker())} canvas[A]=${JSON.stringify(canvasMarker())}`);
  console.log(`  ⇒ ${flowMarker() !== true ? "载入即自愈（用户不会看到锁）" : "仍为 true"}`);
}
