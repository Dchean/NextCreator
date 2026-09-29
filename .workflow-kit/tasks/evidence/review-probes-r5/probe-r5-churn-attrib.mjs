/**
 * 独立审查探针 R3-C（TASK-006 第三轮 / 性能与可维护性）
 *
 * ① pump.finally 的收尾复核（queueStore.ts:511）在**标记本来就是 false**（或节点上根本没有这一位）
 *    时仍然会走到 clearNodeQueuedMarker：两条动态 import + 两次 store 写入，且
 *    · flowStore.updateNodeData 无条件 set({nodes: map(...)}) → nodes 数组与节点对象都是**新身份**；
 *    · canvasStore 分支无条件 setState({canvases: map(...)}) → canvases 也是新身份。
 *    于是每完成一个任务都产生一次"假变更"：App.tsx:170 的 subscribe → 800ms 防抖 →
 *    canvasStore.updateCanvasData → persist → tauriStorage.setItem → 500ms 防抖写盘 app-data.json。
 * ② cancel 的 running 分支调用 clearNodeQueuedMarkerIfNoActiveJob 时，被取消的任务此刻**仍是 running**
 *    且就在 jobs 里，谓词必然判为"有活动任务"→ 该调用恒为 no-op（永远不会清除）。
 *
 * 用法：node --experimental-strip-types probe-r3-finally-churn.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

let SET_CALLS = [];
globalThis.__NC_STORE_SEED__ = {};
globalThis.__NC_SET_LOG__ = SET_CALLS;

const STUBS = {
  "@xyflow/react": `export const ReactFlow=()=>null;export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;
    export const addEdge=(e,es)=>es;export const MarkerType={};export const Position={};export const ConnectionLineType={};
    export const SelectionMode={};export const useStore=()=>({});export default {};`,
  "@tauri-apps/api/core": `export const invoke=async()=>{throw new Error("stub invoke");};export const Channel=class{};export const convertFileSrc=(p)=>p;export default {};`,
  "@tauri-apps/api/event": `export const listen=async()=>()=>{};export const emit=async()=>{};export default {};`,
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}
    async get(k){return (globalThis.__NC_STORE_SEED__||{})[k] ?? null;}
    async set(k,v){ (globalThis.__NC_SET_LOG__||[]).push(k); }async save(){}async delete(){}async keys(){return [];}}
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
const EXEC_SRC = `
export const executeImageGeneration = async (nodeId, options) => {
  await new Promise((r) => setTimeout(r, 10));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const X = "gen-x";
const C1 = "c1";
// 标记本来就是 false —— 节点确实"未排队"
const nodeData = { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", queued: false };
useCanvasStore.setState({
  canvases: [{ id: C1, name: "c1", nodes: [{ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: nodeData }], edges: [] }],
  activeCanvasId: C1,
  _hasHydrated: true,
});
useFlowStore.setState({ nodes: [{ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: nodeData }], edges: [] });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });

const nodesBefore = useFlowStore.getState().nodes;
const nodeObjBefore = nodesBefore[0];
const canvasesBefore = useCanvasStore.getState().canvases;

// 记录 App.tsx:170 同构的 subscribe 触发次数
let subscribeHits = 0;
useFlowStore.subscribe((s, p) => {
  if (s.nodes === p.nodes && s.edges === p.edges) return;
  subscribeHits++;
});

SET_CALLS.length = 0;

console.log("① 标记本来就是 false（节点未排队）时，一个任务自然结束会做些什么：");
useQueueStore.getState().enqueue({ nodeId: X, canvasId: C1, nodeLabel: "X", modelLabel: "m", promptPreview: "p" });
await sleep(150);

const nodesAfter = useFlowStore.getState().nodes;
const canvasesAfter = useCanvasStore.getState().canvases;
console.log(`  job 终态=${useQueueStore.getState().jobs[0].status}`);
console.log(`  flowStore.nodes 身份变化=${nodesBefore !== nodesAfter}  节点对象身份变化=${nodeObjBefore !== nodesAfter[0]}`);
console.log(`  canvasStore.canvases 身份变化=${canvasesBefore !== canvasesAfter}`);
console.log(`  节点数据内容真的变了吗：queued=${JSON.stringify(nodesAfter[0].data.queued)}（与清理前相同）`);
console.log(`  App.tsx:170 同构的 subscribe 命中次数=${subscribeHits}（>0 即触发 800ms 防抖回写画布）`);
console.log(`  persist 写入键=${JSON.stringify(SET_CALLS)}`);

console.log("");
console.log("② cancel 的 running 分支复核是否可能真的清除：");
useFlowStore.setState({ nodes: [{ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { ...nodeData, queued: true } }] });
useQueueStore.setState({
  jobs: [{ id: "job-R", nodeId: X, canvasId: C1, nodeLabel: "X", modelLabel: "m", promptPreview: "p", status: "running", createdAt: 1, startedAt: 1 }],
  paused: true, // 暂停调度器，隔离出 cancel 分支自身的效果
});
console.log(`  [审查者插入] cancel 调用之前：flowStore.queued=${JSON.stringify(useFlowStore.getState().nodes[0].data.queued)} 活动任务=${useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running").length}`);
useQueueStore.getState().cancel("job-R");
console.log(`  [审查者插入] cancel 调用之后（同一同步栈，未 await）：flowStore.queued=${JSON.stringify(useFlowStore.getState().nodes[0].data.queued)}`);
await sleep(80);
const afterCancel = useFlowStore.getState().nodes[0].data.queued;
console.log(`  cancel 后 job 状态=${useQueueStore.getState().jobs[0].status}（abort 是异步的，此刻仍 running）`);
console.log(`  cancel 分支调用前 queued=true，调用后 queued=${JSON.stringify(afterCancel)}`);
console.log(
  afterCancel === true
    ? "  → 该调用恒为 no-op：谓词把**被取消任务自己**算作活动任务，因此 running 分支永不执行清除；\n     真正清除的是 pump 的 .finally（任务真正离开 active 集合之后）。"
    : "  → 该调用确实清除了标记。"
);
