/**
 * 审查探针（第 5 轮 · 独立审查者 · 第四发）：把"三个翻转项"的机制钉死。
 * 假设：自愈订阅在 useFlowStore.setState 的**同步**调用栈里就跑完了，所以任何"先写
 * queued:true、后注入 jobs"的 fixture 都会看到标记在**它自己的 setup 写入那一刻**被清掉
 * —— 与 cancel / 归因逻辑无关。本探针逐项验证该机制，并量化"同步性"。
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

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);

const X = "gen-x";
const A = "canvas-a";
const mk = (queued) => ({ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { prompt: "p", n: 1, status: "idle", label: "L", queued } });
const jr = (status) => ({ id: "job-R", nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", status, createdAt: 1, startedAt: 1 });
const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const canvasMarker = () => useCanvasStore.getState().canvases.find((c) => c.id === A)?.nodes.find((n) => n.id === X)?.data?.queued;
const cmark = () => useCanvasStore.getState().canvases.find((c) => c.id === A)?.nodes.find((n) => n.id === X)?.data?.queued;

console.log("========== 机制 1：自愈是否在 setState 的同步调用栈里完成（无 await）==========");
useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk(true)], edges: [] }], activeCanvasId: A, _hasHydrated: true });
useQueueStore.setState({ jobs: [], paused: true, concurrency: 1 });
useFlowStore.setState({ nodes: [mk(true)], edges: [] });
console.log(`  写入 queued:true（jobs 为空）后**同一同步栈内**读：flowStore=${JSON.stringify(marker())} canvasStore=${JSON.stringify(cmark())}`);
console.log(`  ⇒ ${marker() !== true ? "自愈在 setState 返回前就已清掉（同步）→ 任何\"先写标记后注入 jobs\"的 fixture 都会被它当场清掉" : "异步/未触发"}`);

console.log("");
console.log("========== 机制 2：复刻 probe-r3-finally-churn 步骤② 的真实写法 ==========");
{
  // 与 fixture 完全相同：先 setState 写 queued:true（队列里此刻是上一步的终态任务），再注入 running 任务，再 cancel
  useQueueStore.setState({ jobs: [jr("success")], paused: true, concurrency: 1 });
  useFlowStore.setState({ nodes: [mk(true)], edges: [] });
  const rightAfterSetup = marker();     // fixture 里这一行之后没有任何测量，直接假定"调用前 queued=true"
  useQueueStore.setState({ jobs: [jr("running")], paused: true });
  const beforeCancel = marker();
  useQueueStore.getState().cancel("job-R");
  const afterCancel = marker();
  console.log(`  fixture 的 setup setState 之后（同步读）：queued=${JSON.stringify(rightAfterSetup)}  ← fixture 打印的"调用前 queued=true"是**硬编码字符串**，不是测量值`);
  console.log(`  注入 running 任务后、cancel 之前：queued=${JSON.stringify(beforeCancel)}`);
  console.log(`  cancel("job-R")（running 分支）之后：queued=${JSON.stringify(afterCancel)}  job 状态=${useQueueStore.getState().jobs[0].status}`);
  console.log(`  ⇒ 标记的清除发生在 fixture 自己的 setup 写入那一刻（队列里只有上一步的终态任务 → 自愈判定为陈旧），`);
  console.log(`     而 cancel 的 running 分支按代码根本不做复核：清除与 cancel 无因果关系。`);
}

console.log("");
console.log("========== 机制 3：复刻 probe-r3-null-canvas-scope 的注入顺序 ==========");
{
  // fixture：line 98 节点就带 queued:true → line 113 setNodes → line 119 才注入 jobs
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk(true)], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 4 });
  useFlowStore.setState({ nodes: [mk(true)], edges: [] });   // ← 此刻队列对该节点为空，标记必然被判为陈旧
  console.log(`  注入 jobs 之前：flowStore=${JSON.stringify(marker())} canvasStore=${JSON.stringify(cmark())}`);
  useQueueStore.setState({
    jobs: [
      { id: "job-R", nodeId: X, canvasId: null, nodeLabel: "L", modelLabel: "m", promptPreview: "p", status: "running", createdAt: 1, startedAt: 1 },
      { id: "job-Q", nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: 2 },
    ],
  });
  console.log(`  注入 jobs 之后（fixture 的"步骤 0"）：flowStore=${JSON.stringify(marker())} ← fixture 期望这里是 true`);
  console.log(`  ⇒ 复现结论由**fixture 的注入顺序**决定，而不是由 cancel 路径决定：真实代码里 enqueue 先于 hook 写标记，`);
  console.log(`     不存在"标记已 true 而该节点还没有任何任务"的合法状态（唯一例外是撤销复活，那正是自愈要清的）。`);
}

console.log("");
console.log("========== 机制 4：probe-r4-import2 F2 的 mkNode() 无参 → 前置条件根本没建立 ==========");
{
  // F2 的 setup：mkNode() 不带参数 → data.queued 为 undefined；两个画布副本都一样
  const mkNoArg = () => ({ id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: { prompt: "p", n: 1, status: "idle", label: "L", queued: undefined } });
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mkNoArg()], edges: [] }, { id: "canvas-b", name: "B", nodes: [mkNoArg()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: [mkNoArg()], edges: [] });
  useQueueStore.setState({ jobs: [], paused: true, concurrency: 1 });
  useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
  useCanvasStore.setState({ activeCanvasId: "canvas-b" });
  useFlowStore.setState({ nodes: [mkNoArg()], edges: [] });
  useQueueStore.getState().enqueue({ nodeId: X, canvasId: "canvas-b", nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
  const two = useQueueStore.getState().jobs.filter((j) => j.nodeId === X);
  const anyTrue = () => [marker(), cmark(), useCanvasStore.getState().canvases.find((c) => c.id === "canvas-b")?.nodes.find((n) => n.id === X)?.data?.queued].some((v) => v === true);
  console.log(`  F2 setup 后（撤销 A 之前）：任一载体为 true=${anyTrue()} ← 期望 true 才有可保留的标记，实际 ${anyTrue()}`);
  useQueueStore.getState().cancel(two.find((j) => j.canvasId === A).id);
  console.log(`  取消 A（B 仍 queued）后任一载体为 true=${anyTrue()}  ← fixture 把这个 false 判成"FAIL（误清）"，`);
  console.log(`     但它从未建立过 true：断言是一条对空前置条件的判定（"从没有过，所以没有被误清"）。`);
}

console.log("");
console.log("========== 机制 5：in-place 写 data.queued（不改数组身份）不会被自愈看到 ==========");
{
  useQueueStore.setState({ jobs: [], paused: true, concurrency: 1 });
  useFlowStore.setState({ nodes: [mk(false)], edges: [] });
  useFlowStore.getState().nodes[0].data.queued = true;   // 原地写
  console.log(`  原地点写后（无身份变化）：queued=${JSON.stringify(marker())} ← 自愈按身份比较，不会触发`);
  console.log(`  ⇒ 是否构成缺陷取决于仓库里是否存在这种写入方（grep 结论见报告：唯一写入方都换新对象）`);
}
