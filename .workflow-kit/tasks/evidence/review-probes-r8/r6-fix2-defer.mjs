/**
 * 独立审查探针 R6-B（round 6, F-R5-2）：自愈订阅的重入保护是"延后"而不是"丢弃"。
 * 与 worker 的 probe-r5fix2-defer.mjs 无关：夹具、断言、以及"突变体验证"全部自建。
 *
 * 用法：
 *   node --experimental-strip-types r6-fix2-defer.mjs                     # 真实候选
 *   set R6_QS=<path to mutant queueStore.ts> && node ... r6-fix2-defer.mjs # 突变体（旧行为：丢弃）
 *
 * 断言：
 *  ① 嵌套写入在治疗期间**新引入**的陈旧 true 必须被纠正（旧实现下永久存活）；
 *  ② 该纠正必须覆盖所有载体（flowStore + 画布副本）；
 *  ③ 嵌套写入引入的标记若**合法**（该 nodeId 真有 queued||running 任务）不得被误清；
 *  ④ 标记本来 falsy 时：零写入、零身份变化、画布零写入（F-R3-2 不回归）；
 *  ⑤ 有候选时：嵌套写入方停止后收敛（不死循环），且写入方**有条件**（非每通知必写）时也收敛 —— 见 ⑥；
 *  ⑥ 【关键】"有条件"的写入方（只在看不到任何 true 时才写回一个 true）与自愈组合是否收敛？
 *     —— 探针用 setInterval 之外的**同步统计**：记录 heal 轮数与写入次数，超过阈值即判定不收敛。
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const X = "gen-x";
const Y = "gen-y";
const A = "canvas-a";
const B = "canvas-b";
const QS = process.env.R6_QS && existsSync(process.env.R6_QS)
  ? process.env.R6_QS
  : path.join(SRC, "stores/queueStore.ts");
const IS_MUTANT = QS !== path.join(SRC, "stores/queueStore.ts");

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
const { createRequire } = await import("node:module");
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
const flowMarker = (id) => useFlowStore.getState().nodes.find((n) => n.id === id)?.data?.queued;
const canvasMarker = (cid, id) =>
  useCanvasStore.getState().canvases.find((c) => c.id === cid)?.nodes.find((n) => n.id === id)?.data?.queued;
const job = (id, nodeId, canvasId, status) => ({
  id, nodeId, canvasId, nodeLabel: "L", modelLabel: "m", promptPreview: "p", status, createdAt: Date.now(),
});

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
};

function seed({ canvases, activeCanvasId = A, flowNodes, jobs = [] }) {
  useQueueStore.setState({ jobs, paused: true, concurrency: 1 });
  useCanvasStore.setState({ canvases, activeCanvasId, _hasHydrated: true });
  useFlowStore.setState({ nodes: flowNodes, edges: [], history: [], historyIndex: -1 });
}

console.log(`模块来源：${IS_MUTANT ? "突变体（旧行为：丢弃嵌套通知）" : "真实候选"} → ${QS}`);
console.log("");
console.log("========== ①/② 嵌套写入引入的陈旧 true 必须被纠正（含所有载体）==========");
{
  seed({ canvases: [{ id: A, name: "A", nodes: [mk(X, true), mk(Y, false)], edges: [] }], flowNodes: [mk(X, false), mk(Y, false)] });
  await sleep(15);
  // 起始现场：只有 X 是候选（无活动任务）；Y 稍后由嵌套写入方引入
  useFlowStore.setState({ nodes: [mk(X, true), mk(Y, false)] });

  let nestedWrites = 0;
  const NESTED_CAP = 5;
  const unsubNested = useFlowStore.subscribe(() => {
    if (nestedWrites >= NESTED_CAP) return;
    if (flowMarker(Y) !== true) {
      nestedWrites++;
      useFlowStore.setState({
        nodes: useFlowStore.getState().nodes.map((n) => (n.id === Y ? { ...n, data: { ...n.data, queued: true } } : n)),
      });
    }
  });
  // 触发 heal：X=true 是候选（无活动任务）
  useFlowStore.setState({ nodes: [mk(X, true), mk(Y, false)] });
  await sleep(40);
  unsubNested();
  console.log(`  嵌套写入方触发次数=${nestedWrites}  X=${JSON.stringify(flowMarker(X))} Y=${JSON.stringify(flowMarker(Y))}`);
  console.log(`  载体：canvas[A].X=${JSON.stringify(canvasMarker(A, X))} canvas[A].Y=${JSON.stringify(canvasMarker(A, Y))}`);
  check(nestedWrites >= 1, "夹具有效：嵌套写入真实发生（探针非空跑）");
  check(flowMarker(Y) === false, IS_MUTANT ? "（突变体预期 FAIL）Y 被纠正" : "Y 的陈旧 true 被延后的一轮纠正");
  check(canvasMarker(A, Y) === false, "Y 的画布副本也被清（clearNodeQueuedMarker 覆盖所有载体）");
}

console.log("");
console.log("========== ③ 延后一轮不得误清**合法**标记（F-R3-1/F-R2-2 保持）==========");
{
  seed({
    canvases: [{ id: A, name: "A", nodes: [mk(X, true)], edges: [] }, { id: B, name: "B", nodes: [mk(X, true)], edges: [] }],
    flowNodes: [mk(X, false)],
    jobs: [job("jB", X, B, "queued")],
  });
  let fired = false;
  const unsub = useFlowStore.subscribe(() => { fired = true; });
  useFlowStore.setState({ nodes: [mk(X, true)] });
  await sleep(30);
  unsub();
  console.log(`  flowStore=${JSON.stringify(flowMarker(X))} canvas[A]=${JSON.stringify(canvasMarker(A, X))} canvas[B]=${JSON.stringify(canvasMarker(B, X))}`);
  check(flowMarker(X) === true && canvasMarker(A, X) === true && canvasMarker(B, X) === true,
    "另一画布上有 queued 任务 → 按 nodeId 口径保留合法标记（未被误清）");
  check(fired, "复核确实运行过（不是因为没有订阅而空过）");
}

console.log("");
console.log("========== ④ 标记本来 falsy：零写入 / 零身份变化 / 画布零写入（F-R3-2）==========");
{
  seed({ canvases: [{ id: A, name: "A", nodes: [mk(X, false)], edges: [] }], flowNodes: [mk(X, false)] });
  await sleep(15);
  const canvasesBefore = useCanvasStore.getState().canvases;
  const trigger = [mk(X, false)];
  useFlowStore.setState({ nodes: trigger });
  await sleep(30);
  const untouched = useFlowStore.getState().nodes === trigger;
  console.log(`  传入数组未被替换=${untouched} 画布身份未变=${canvasesBefore === useCanvasStore.getState().canvases}`);
  check(untouched, "零写入、零身份变化（早退发生在置位重入标志之前）");
  check(canvasesBefore === useCanvasStore.getState().canvases, "画布未被写入（无落盘 churn）");
}

console.log("");
console.log("========== ⑤ 有候选、写入方有限：收敛 + 只多出必要的清除写入 ==========");
{
  seed({ canvases: [{ id: A, name: "A", nodes: [mk(X, true)], edges: [] }], flowNodes: [mk(X, false)] });
  await sleep(15);
  let identityChanges = 0;
  const unsubW = useFlowStore.subscribe((s, p) => { if (s.nodes !== p.nodes) identityChanges++; });
  const trigger = [mk(X, true)];
  useFlowStore.setState({ nodes: trigger });
  const replaced = useFlowStore.getState().nodes !== trigger;
  await sleep(40);
  unsubW();
  console.log(`  heal 是否写了新数组=${replaced} 之后身份变化次数=${identityChanges - 1}（已减去触发本身）`);
  console.log(`  heal 的 for(;;) 迭代次数=${globalThis.__HEAL_ITERS__ ?? "（未插桩）"}`);
  check(replaced && flowMarker(X) === false, "标记被清");
  check(identityChanges - 1 === 1, `只多出 1 次身份变化（实际 ${identityChanges - 1}）→ 延后机制未产生额外写入`);
  check((globalThis.__HEAL_ITERS__ ?? 1) >= 1, "（插桩信息，非断言）记录迭代次数");
}

console.log("");
console.log("========== ⑥ 【终止性攻击】有条件写入方（看不到 true 就写回一个）与自愈是否收敛？==========");
{
  seed({ canvases: [{ id: A, name: "A", nodes: [mk(X, true)], edges: [] }], flowNodes: [mk(X, false)] });
  await sleep(15);
  // 写入方 W：**条件**的、自身有界的 —— 只在"看不到任何 queued:true"时写回 X=true。
  // 单独运行时 W 收敛（写完一次后下一次通知里它看到 true，不再写）。
  let wWrites = 0;
  const unsubW = useFlowStore.subscribe(() => {
    const anyTrue = useFlowStore.getState().nodes.some((n) => n.data?.queued === true);
    if (!anyTrue) {
      wWrites++;
      if (wWrites > 200) return; // 硬闸：避免探针自身把 Node 卡死（超过阈值即视为不收敛）
      useFlowStore.setState({
        nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)),
      });
    }
  });
  const t0 = Date.now();
  let syncDone = false;
  useFlowStore.setState({ nodes: [mk(X, true)] }); // 触发 heal
  syncDone = true;
  const syncMs = Date.now() - t0;
  await sleep(60);
  unsubW();
  console.log(`  同步栈耗时=${syncMs}ms W 写入次数=${wWrites}（硬闸 200）最终 X=${JSON.stringify(flowMarker(X))}`);
  if (wWrites > 200) {
    console.log("  ⇒ 【不收敛】条件型写入方与自愈形成同步振荡：每一轮 heal 清 X → W 看到无 true → 写回 X=true →");
    console.log("     置位 healPending → 再跑一轮 → ……。该写入方**自身有界**（单独运行时写一次即停），");
    console.log("     因此注释中『唯一能让它不退出的是自身无界的写入方』这一全称判断不成立。");
  } else {
    console.log(`  ⇒ 收敛（W 写入 ${wWrites} 次后停止）。`);
  }
  check(wWrites <= 200, "延后循环在条件型写入方下仍然终止");
  check(wWrites <= 3, `条件型写入方在 3 次内收敛（实际 ${wWrites} 次）`);
}

console.log("");
console.log(`RESULT: ${failures === 0 ? "F-R5-2 延后生效、有界、无误清、正常路径无额外写入（全部断言通过）" : `仍有 ${failures} 条断言未通过`}${IS_MUTANT ? "  [突变体模式]" : ""}`);
process.exitCode = failures === 0 ? 0 : 1;
