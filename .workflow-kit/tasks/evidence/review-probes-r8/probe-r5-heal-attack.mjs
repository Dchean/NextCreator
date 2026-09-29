/**
 * 审查探针（第 5 轮 · 独立审查者）：攻击本轮新增的"自愈订阅"本身。
 * 关注点：
 *   1) reentrancy 标志能否造成**漏清**（heal 进行中，内层合法变更被吞掉，陈旧 true 残留）；
 *   2) 订阅回调内写**其他 store**（canvasStore.setState）是否能丢/乱序更新或抛错；
 *   3) 订阅是否在 store 就绪前触发 / 是否可能与后续 setNodes 形成"永不触发"的窗口；
 *   4) 每次 nodes 换身份都跑 O(n) 扫描 → 拖拽场景的代价与分配；
 *   5) 非活动画布副本上的陈旧 true，在其被载入 flowStore 时是否治愈、载入前窗口是否可见；
 *   6) 能否写出一个"没有后续 nodes 身份变化"的陈旧 true → 自愈永不触发。
 * 用法：node --experimental-strip-types probe-r5-heal-attack.mjs
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
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const X = "gen-x";
const Y = "gen-y";
const A = "canvas-a";
const B = "canvas-b";
const D = () => ({ ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" });
const mk = (id, queued) => ({
  id,
  type: "imageGeneratorNode",
  position: { x: 0, y: 0 },
  data: { ...D(), ...(queued === undefined ? {} : { queued }) },
});
const flowMarker = (id = X) => useFlowStore.getState().nodes.find((n) => n.id === id)?.data?.queued;
const canvasMarker = (cid, id = X) =>
  useCanvasStore.getState().canvases.find((c) => c.id === cid)?.nodes.find((n) => n.id === id)?.data?.queued;
const job = (id, nodeId, canvasId, status) => ({
  id, nodeId, canvasId, nodeLabel: "L", modelLabel: "m", promptPreview: "p", status, createdAt: Date.now(),
});
function reset(canvases, activeCanvasId, flowNodes, jobs = []) {
  useCanvasStore.setState({ canvases, activeCanvasId, _hasHydrated: true });
  useFlowStore.setState({ nodes: flowNodes, edges: [], history: [], historyIndex: -1 });
  useQueueStore.setState({ jobs, paused: true, concurrency: 1 });
}

console.log("========== 子项 1：订阅是否真的在模块顶层建立（import 即生效、无需任何调用）==========");
reset([{ id: A, name: "A", nodes: [mk(X, true)], edges: [] }], A, [mk(X, true)], []);
console.log(`  仅 import queueStore 后：flowStore 起点 queued=${JSON.stringify(flowMarker())}`);
useFlowStore.setState({ nodes: [mk(X, true)] });   // 一次身份变化，无任何 queueStore 调用
await sleep(10);
console.log(`  人为换一次 nodes 身份（无任何 queueStore 调用）后 queued=${JSON.stringify(flowMarker())} 画布副本=${JSON.stringify(canvasMarker(A))}`);
console.log(`  ⇒ ${flowMarker() !== true ? "订阅确实在模块加载时即生效（无需调用 queueStore 任何 API）" : "订阅未生效（模块顶层副作用未注册）"}`);

console.log("");
console.log("========== 子项 2：heal 扫描规模 = 每次 nodes 换身份都跑（拖拽/选中）==========");
{
  const N = 400;
  const big = Array.from({ length: N }, (_, i) => mk(`n-${i}`, false));
  useFlowStore.setState({ nodes: big });
  // 计时：制造 200 次身份变化（模拟拖拽），每次有 1 个候选
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) {
    useFlowStore.setState({ nodes: big.map((n) => (n.id === "n-3" ? { ...n, position: { x: i, y: 0 } } : n)) });
  }
  const t1 = process.hrtime.bigint();
  console.log(`  ${N} 个节点、200 次身份变化、每次 1 个候选：${Number(t1 - t0) / 1e6}ms（含 map 构造成本）`);
  console.log(`  ⇒ 空候选时 heal 在构造 candidates 数组前就 return，无分配；有候选才分配一个 string[]`);
}
{
  // 极端：大量节点同时为 true（撤销恢复整数组）时的扫描
  const N = 400;
  const big = Array.from({ length: N }, (_, i) => mk(`n-${i}`, true));
  useQueueStore.setState({ jobs: [] });
  const t0 = process.hrtime.bigint();
  useFlowStore.setState({ nodes: big });
  const t1 = process.hrtime.bigint();
  console.log(`  400 个节点全为 true（撤销恢复形态）→ 一次 heal ${Number(t1 - t0) / 1e6}ms；全部清空后剩余 true = ${useFlowStore.getState().nodes.filter((n) => n.data.queued === true).length}`);
  console.log(`  ⇒ O(nodes) 扫描 + O(candidates × jobs) 谓词；候选为空时零分配（提前 return）`);
}

console.log("");
console.log("========== 子项 3：重入标志能否造成漏清（heal 进行中发生合法/非法写入）==========");
{
  // 构造：heal 的第一轮里，内部清 A 时，某个 flowStore 订阅者（模拟 App.tsx 或第三方）
  // 在同一个同步栈里把**另一个节点** B 写成陈旧 true。此时 healingQueuedMarkers=true，
  // 嵌套通知被丢弃 → B 的陈旧 true 是否会被本轮/后续清掉？
  reset([{ id: A, name: "A", nodes: [mk(X, true), mk(Y, false)], edges: [] }], A, [mk(X, true), mk(Y, false)], []);
  let nested = false;
  const unsub = useFlowStore.subscribe(() => {
    if (nested) return;
    nested = true;
    // 在 heal 触发的通知里，再写一次 nodes 身份，把 Y 变成陈旧 true
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === Y ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  useFlowStore.setState({ nodes: [mk(X, true), mk(Y, false)] }); // 触发 heal（X 是候选，无活动任务 → 会清）
  await sleep(20);
  console.log(`  嵌套写入后：X=${JSON.stringify(flowMarker(X))}（应 false：被 heal 清） Y=${JSON.stringify(flowMarker(Y))}（陈旧 true，看是否漏清）`);
  unsub();
  // 关键：再没有后续身份变化时，Y 会不会永远留着？
  await sleep(50);
  console.log(`  （此后无任何身份变化）Y 仍为 ${JSON.stringify(flowMarker(Y))} → ${flowMarker(Y) === true ? "漏清：重入标志把嵌套通知吞掉，且没有后续变化来重跑" : "已被清除"}`);
  console.log(`  画布副本 Y：${JSON.stringify(canvasMarker(A, Y))}`);
}

console.log("");
console.log("========== 子项 4：heal 里写 canvasStore 是否安全（嵌套 set 的更新是否丢失）==========");
{
  // heal 过程中 canvasStore.setState 换 canvases 身份；同时验证画布上其他字段/其他画布不被丢
  reset(
    [
      { id: A, name: "A", nodes: [mk(X, true)], edges: [], extra: "keep-A" },
      { id: B, name: "B", nodes: [mk(X, false)], edges: [], extra: "keep-B" },
    ],
    A,
    [mk(X, true)],
    []
  );
  let canvasNotices = 0;
  const unsubC = useCanvasStore.subscribe(() => canvasNotices++);
  useFlowStore.setState({ nodes: [mk(X, true)] });
  await sleep(20);
  unsubC();
  const cs = useCanvasStore.getState();
  console.log(`  canvasStore 通知次数=${canvasNotices}；A.queued=${JSON.stringify(canvasMarker(A))} B.queued=${JSON.stringify(canvasMarker(B))}`);
  console.log(`  额外字段保持：A.extra=${JSON.stringify(cs.canvases.find((c) => c.id === A).extra)} B.extra=${JSON.stringify(cs.canvases.find((c) => c.id === B).extra)}`);
  console.log(`  activeCanvasId 未被 heal 改动：${cs.activeCanvasId === A}`);
  console.log(`  ⇒ ${canvasMarker(A) === false ? "heal 内嵌套写 canvasStore 落地成功，其他画布/字段完整" : "嵌套写失败"}`);
}

console.log("");
console.log("========== 子项 5：非活动画布副本上的陈旧 true（flowStore 里根本没有该节点）==========");
{
  reset(
    [
      { id: A, name: "A", nodes: [mk(X, false)], edges: [] },
      { id: B, name: "B", nodes: [mk(X, true)], edges: [] },   // B 从未载入 flowStore
    ],
    A,
    [mk(X, false)],
    []
  );
  useFlowStore.setState({ nodes: [mk(X, false)] }); // 触发 heal，但 flowStore 里没有 true
  await sleep(20);
  console.log(`  切到 B 之前：flowStore=${JSON.stringify(flowMarker())} canvas[A]=${JSON.stringify(canvasMarker(A))} canvas[B]=${JSON.stringify(canvasMarker(B))} ← B 的陈旧 true 存活，无订阅看得到`);
  // 打开 B（App.tsx:154 同构：setNodes(canvas.nodes)）
  const bNodes = useCanvasStore.getState().canvases.find((c) => c.id === B).nodes;
  useFlowStore.setState({ nodes: bNodes });
  await sleep(20);
  console.log(`  打开 B（setNodes 同构）之后：flowStore=${JSON.stringify(flowMarker())} canvas[B]=${JSON.stringify(canvasMarker(B))}`);
  console.log(`  ⇒ ${flowMarker() !== true && canvasMarker(B) !== true ? "载入即自愈" : "载入后仍是 true = 用户可见的 排队中 锁"}`);
}

console.log("");
console.log("========== 子项 6：陈旧 true 能否写进\"没有后续身份变化\"的状态（自愈永不触发）==========");
{
  reset([{ id: A, name: "A", nodes: [mk(X, false)], edges: [] }], A, [mk(X, false)], []);
  // 直接原地改 data（不换数组身份）—— 真实代码里是否存在这种写入？
  const nodes = useFlowStore.getState().nodes;
  nodes[0].data.queued = true;
  await sleep(20);
  console.log(`  原地点写（不改数组身份）：queued=${JSON.stringify(flowMarker())}（订阅按身份比较，不会触发）`);
  // 随后任何一次身份变化才可能纠正
  useFlowStore.setState({ nodes: [...useFlowStore.getState().nodes] });
  await sleep(20);
  console.log(`  再发生一次身份变化后：queued=${JSON.stringify(flowMarker())}`);
  console.log(`  ⇒ 结论取决于仓库里是否存在"原地写 data.queued"的写入方（grep 结果见报告）`);
}

console.log("");
console.log("========== 子项 7：撤销/重做（真实入口）后自愈是否当场生效、防抖读到什么 ==========");
{
  reset([{ id: A, name: "A", nodes: [mk(X, true)], edges: [] }], A, [mk(X, true)], [job("j1", X, A, "queued")]);
  useFlowStore.setState({ nodes: [mk(X, true)], edges: [] });
  useFlowStore.getState().saveToHistory();          // 快照拍到 queued:true
  useQueueStore.setState({ jobs: [job("j1", X, A, "cancelled")] }); // 任务终结 → 无活动任务
  useQueueStore.getState().cancel("j1");
  await sleep(10);
  console.log(`  取消后：flowStore=${JSON.stringify(flowMarker())} canvas[A]=${JSON.stringify(canvasMarker(A))} 活动任务=${useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running").length}`);
  useFlowStore.getState().undo();                    // 快照把 true 写回
  await sleep(20);
  console.log(`  Ctrl+Z 之后：flowStore=${JSON.stringify(flowMarker())} 活动任务=${useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running").length}`);
  console.log(`  ⇒ ${flowMarker() !== true ? "撤销复活的陈旧 true 被自愈当场收回（R4 缺陷已闭合）" : "陈旧 true 存活 = R4 缺陷未闭合"}`);
}

console.log("");
console.log("========== 子项 8：自愈不得误清合法标记（含另一画布同名节点的活动任务）==========");
{
  reset(
    [
      { id: A, name: "A", nodes: [mk(X, true)], edges: [] },
      { id: B, name: "B", nodes: [mk(X, true)], edges: [] },
    ],
    A,
    [mk(X, true)],
    [job("jB", X, B, "queued")]   // 活动任务在**另一画布**上
  );
  useFlowStore.setState({ nodes: [mk(X, true)] });
  await sleep(20);
  console.log(`  仅 B 上有 queued 任务时：flowStore=${JSON.stringify(flowMarker())} canvas[A]=${JSON.stringify(canvasMarker(A))} canvas[B]=${JSON.stringify(canvasMarker(B))}`);
  console.log(`  ⇒ ${flowMarker() === true ? "保留（nodeId 口径，errs safe）——F-R3-1 性质保持" : "误清 = F-R3-1 回归"}（期望保留：谓词按 nodeId 看到 B 的 queued 任务）`);
}
{
  reset([{ id: A, name: "A", nodes: [mk(X, true)], edges: [] }], A, [mk(X, true)], [job("jR", X, A, "running")]);
  useFlowStore.setState({ nodes: [mk(X, true)] });
  await sleep(20);
  console.log(`  仅 running 任务时（不得算作"该清"）：flowStore=${JSON.stringify(flowMarker())} → ${flowMarker() === true ? "保留，正确" : "误清"}`);
}

console.log("");
console.log("========== 子项 9：订阅在 store 未就绪/模块初始化环上的行为 ==========");
{
  console.log(`  flowStore 是否 import queueStore：${/from "@\/stores\/queueStore"/.test(await (await import("node:fs/promises")).readFile(path.join(SRC, "stores/flowStore.ts"), "utf8")) ? "是（存在环）" : "否（无环）"}`);
}
