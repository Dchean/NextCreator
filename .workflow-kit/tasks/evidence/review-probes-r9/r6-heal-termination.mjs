/**
 * 独立审查探针 R6-C（round 6）：验证 `healStaleQueuedMarkers` 延后循环的**终止性**。
 *
 * 关键点：探针自己**不**写 nodes，而是给 queueStore 的清除动作装一个计数器包装，
 * 用一个"外部同步写入方"（模拟 flowStore 的另一个订阅者，如 App.tsx 的防抖回写路径上的
 * 其它整数组写入）在 heal 的写入里**有条件**地重新引入 true。
 *
 * 为了不把本进程卡死：写入方带硬预算 W_MAX，超过预算即停止注入，探针据"是否触顶"判定。
 *
 * 变体 A（有界写入方）：W 只注入 3 次 → 期望收敛。
 * 变体 B（条件写入方，自身有界）：W 只在"当前没有任何 true"时注入一次 → 这是"自身有界"的写入方，
 *        单独运行时写 1 次即停；与自愈组合若无限互激即为**不终止**。
 *
 * 用法：node --experimental-strip-types r6-heal-termination.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const X = "gen-x";
const A = "canvas-a";

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
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const D = () => ({ ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" });
const mk = (id, queued) => ({
  id, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...D(), ...(queued === undefined ? {} : { queued }) },
});
const marker = (id) => useFlowStore.getState().nodes.find((n) => n.id === id)?.data?.queued;

/** 统计 heal 实际产生的 flowStore.nodes 身份变化次数（= 每轮清除写入数） */
function installCounter() {
  let writes = 0;
  const unsub = useFlowStore.subscribe((s, p) => { if (s.nodes !== p.nodes) writes++; });
  return { get: () => writes, unsub };
}

function seed({ flowNodes, canvasNodes, jobs = [] }) {
  useQueueStore.setState({ jobs, paused: true, concurrency: 1 });
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: canvasNodes ?? flowNodes, edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: flowNodes, edges: [], history: [], historyIndex: -1 });
}

const W_MAX = 50;

console.log("========== 变体 A：有界写入方（只注入 3 次）→ 期望收敛 ==========");
{
  seed({ flowNodes: [mk(X, false)] });
  await sleep(15);
  // W_MAX 预算内的"有界注入方"：每次在 heal 写入里重新置 true，最多 3 次
  let inject = 0;
  const unsubW = useFlowStore.subscribe(() => {
    if (inject >= 3) return;
    inject++;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => ({ ...n, data: { ...n.data, queued: true } })) });
  });
  const t0 = Date.now();
  useFlowStore.setState({ nodes: [mk(X, true)] }); // 触发
  const syncMs = Date.now() - t0;
  await sleep(40);
  unsubW();
  console.log(`  同步栈耗时=${syncMs}ms 注入次数=${inject} 最终 X=${JSON.stringify(marker(X))}`);
  console.log(`  ⇒ 收敛（有界写入方，轮数有限）`);
}

console.log("");
console.log("========== 变体 B：**条件型、自身有界**的写入方 → 自愈是否仍终止？==========");
{
  seed({ flowNodes: [mk(X, false)] });
  await sleep(15);
  // W 的前提：只在"当前看不到任何 queued:true"时写回 X=true。
  // 单独运行 W（无 heal）时：写 1 次 → 下次通知里看到 true → 不再写 ⇒ W 自身**有界**。
  let wWrites = 0;
  let hitCap = false;
  const unsubW = useFlowStore.subscribe(() => {
    const anyTrue = useFlowStore.getState().nodes.some((n) => n.data?.queued === true);
    if (anyTrue) return;
    wWrites++;
    if (wWrites > W_MAX) { hitCap = true; return; } // 硬闸：防止把探针自身卡死
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  const t0 = Date.now();
  useFlowStore.setState({ nodes: [mk(X, true)] });
  const syncMs = Date.now() - t0;
  await sleep(60);
  unsubW();
  console.log(`  同步栈耗时=${syncMs}ms W 写入次数=${wWrites}（硬闸 ${W_MAX}，触顶=${hitCap}）最终 X=${JSON.stringify(marker(X))}`);
  if (hitCap) {
    console.log("  ⇒ 【不终止】条件型写入方 W 自身有界（无 heal 时写 1 次即停），但与自愈组合后互激：");
    console.log("     每轮 heal 清 X → 通知 W → W 看不到 true → 写回 X=true → 置位 healPending → 再跑一轮 → 循环。");
  } else {
    console.log(`  ⇒ 终止（W 共写 ${wWrites} 次）。`);
  }
  console.log(`  与注释的对照：注释称「唯一能让它不退出的是『每收到一次通知就再写一次 nodes』的写入方，`);
  console.log(`  而那种写入方自身就是无界的」。W **不是**「每通知必写」，且自身有界 —— 该全称判断的边界需复核。`);
}

console.log("");
console.log("========== 变体 C：真实仓库里是否存在「整数组写 nodes」的第三方订阅者？==========");
{
  console.log("  rg 结果（src 全量）：.subscribe( 仅 2 处 —— App.tsx:170 与 queueStore.ts:895。");
  console.log("  App.tsx:170 的订阅回调只做 clearTimeout/setTimeout（800ms 后从 flowStore 读值写 canvasStore），不写 flowStore.nodes。");
  console.log("  ⇒ 变体 B 的写入方在**当前仓库**中没有对应实例（是假设性/未来写入方）。");
}
