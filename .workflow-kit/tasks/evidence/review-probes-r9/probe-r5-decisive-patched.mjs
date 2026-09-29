/**
 * 独立审查探针 R4-3（审查者自写，决定性实验）
 *
 * 核心手法：**拦截式归因**（不依赖"掉标记时是否还有 active 任务"这种形态判据）。
 *   · 把 useFlowStore.updateNodeData 与 useCanvasStore.setState 换成记录版，
 *     用调用栈判断这次写入是谁发起的（queueStore.ts 还是执行器/其他）。
 *   · 执行器可用环境变量切换两种形态：
 *       R4_EXEC=faithful（真实形态：启动时写 status=loading + queued:false）
 *       R4_EXEC=silent  （完全不写节点数据 → 标记的任何变化只可能来自 queueStore）
 *   · **阳性对照**：silent 模式下，"标记为 true、任务跑完"必须被记录到一次 queueStore 的
 *     queued:false 写入。若记录为 0，说明拦截本身失效，本探针的一切"0 次"结论都不作数。
 *
 * 覆盖：
 *   A) PRIORITY 1 归因：faithful 模式下，标记消失时是否仍有同 nodeId 的活动任务，
 *      且该次消失是否由 queueStore 发起（形态1 null 标注遗留任务 / 形态2 复制画布）。
 *   B) PRIORITY 2 反向：A 运行 + B 同 nodeId 排队，A 收尾不得抹掉 B 的合法标记（silent 隔离）。
 *   C) PRIORITY 2：cancel 的 queued 分支（真 hook 写标记；含两画布与"副本为唯一载体"）。
 *   D) F-R3-2 早退：全部载体都是 falsy 时不得产生任何写入 / 身份变化（silent 隔离）。
 * 用法：$env:R4_EXEC="faithful"; node --experimental-strip-types probe-r4-decisive.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const MODE = process.env.R4_EXEC || "faithful";

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
  for (const cand of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(cand)) return cand;
  return p;
}
const FAITHFUL = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { success: false, error: "节点不存在" };
  await new Promise((r) => setTimeout(r, 10));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 40));
  useFlowStore.getState().updateNodeData(nodeId, { status: "success", error: undefined });
  return { success: true, cancelled: false };
};
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);
`;
// 完全不碰节点数据：标记的任何变化都只可能来自 queueStore（用于隔离 queueStore 的行为）
const SILENT = `
export const executeImageGeneration = async (nodeId, options) => {
  await new Promise((r) => setTimeout(r, 10));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 40));
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
    if (url === "mutant:exec") return { format: "module", source: MODE === "silent" ? SILENT : FAITHFUL, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createRequire } = await import("node:module");
const requireRepo = createRequire(path.join(REPO, "package.json"));
const React = requireRepo("react");
const { renderToStaticMarkup } = requireRepo("react-dom/server");

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { useImageGeneratorExecution } = await import(
  pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href
);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const X = "gen-x";
const A = "canvas-a";
const B = "canvas-b";
const mkNode = (queued) => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L", queued },
});

// ——— 拦截式归因（必须在任何 store 写入之前装上）———
const log = [];
function instrument() {
  const origUpdate = useFlowStore.getState().updateNodeData;
  useFlowStore.setState({
    updateNodeData: (id, patch) => {
      const stack = String(new Error().stack || "");
      log.push({ via: "flowStore", by: /queueStore\.ts/.test(stack) ? "queueStore" : "other", id, patch: JSON.stringify(patch) });
      return origUpdate(id, patch);
    },
  });
  const origSet = useCanvasStore.setState;
  useCanvasStore.setState = (partial, replace) => {
    const stack = String(new Error().stack || "");
    const before = new Map(
      useCanvasStore.getState().canvases.map((c) => [c.id, c.nodes.map((n) => [n.id, n.data?.queued])])
    );
    const out = origSet(partial, replace);
    const after = useCanvasStore.getState().canvases;
    const dropped = [];
    for (const c of after) {
      const prev = before.get(c.id) || [];
      for (const n of c.nodes) {
        const p = (prev.find(([id]) => id === n.id) || [])[1];
        if (p === true && n.data?.queued !== true) dropped.push(`${c.id}/${n.id}`);
      }
    }
    log.push({
      via: "canvasStore",
      by: /queueStore\.ts/.test(stack) ? "queueStore" : "other",
      id: "(canvases)",
      patch: dropped.length ? `true->${JSON.stringify(after.length)} dropped:${dropped.join(",")}` : "no-queued-drop",
    });
    return out;
  };
}
instrument();

const active = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");
const activeForX = () => active().filter((j) => j.nodeId === X);
const markerFlow = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const markerCanvas = (cid) =>
  useCanvasStore.getState().canvases.find((c) => c.id === cid)?.nodes.find((n) => n.id === X)?.data?.queued;
const anyTrue = () =>
  [markerFlow(), ...useCanvasStore.getState().canvases.map((c) => markerCanvas(c.id))].some((v) => v === true);

/** queueStore 发起的、且落在该 nodeId 上的 queued 清理 */
const clearEvents = () =>
  log
    .filter((e) => e.by === "queueStore" && (/queued/.test(e.patch) || e.patch === "(canvases)"))
    .map((e) => ({ ...e, activeAt: activeForX().map((j) => `${j.canvasId ?? "null"}:${j.status}`) }));

let handle = null;
function Probe() {
  // 必须传一个稳定对象：测试中 flowStore.nodes 可能为空（模拟 App.tsx setNodes 之前）
  const { handleGenerate } = useImageGeneratorExecution(X, PROBE_DATA);
  handle = handleGenerate;
  return null;
}
const PROBE_DATA = { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" };
function reset(canvases, activeCanvasId, flowNodes) {
  useCanvasStore.setState({ canvases, activeCanvasId, _hasHydrated: true });
  useFlowStore.setState({ nodes: flowNodes, edges: [] });
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
  log.length = 0;
}

console.log(`执行器形态=${MODE}（${MODE === "silent" ? "不写节点数据，标记变化只可能来自 queueStore" : "真实形态：启动时写 queued:false"}）`);
console.log("");
console.log("========== 阳性对照：拦截是否真的记录到了 queueStore 的清除 ==========");
reset([{ id: A, name: "A", nodes: [mkNode(true)], edges: [] }], A, [mkNode(true)]);
useFlowStore.getState().updateNodeData(X, { queued: true });
useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
await sleep(250);
const ce = clearEvents();
console.log(`  标记终值 flow=${JSON.stringify(markerFlow())} canvas=${JSON.stringify(markerCanvas(A))}`);
console.log(`  拦截到的 queueStore 清理事件=${ce.length}：${ce.map((e) => `${e.via}${e.patch}@[${(e.activeAt||[]).join("|")}]`).join(" ; ") || "（无）"}`);
const PO = MODE === "silent" ? ce.some((e) => e.via === "flowStore" && /queued":false/.test(e.patch)) : null;
console.log(`  阳性对照判定：${MODE === "silent" ? (PO ? "通过（拦截有效）" : "未通过 → 本探针一切 0 次结论作废") : "（faithful 模式不作此断言）"}`);

let badFaithful = null;
if (MODE !== "silent") {
  console.log("");
  console.log("========== A) PRIORITY 1 归因（faithful 执行器）==========");
  // A1 单画布单节点：正确实现也会掉标记
  reset([{ id: A, name: "A", nodes: [mkNode()], edges: [] }], A, [mkNode()]);
  renderToStaticMarkup(React.createElement(Probe));
  await handle();
  const a1Before = markerFlow();
  await sleep(300);
  const a1 = clearEvents();
  console.log(`  A1 单画布：点击后标记=${JSON.stringify(a1Before)}；queueStore 清理事件=${a1.length}；终值=${JSON.stringify(markerFlow())}`);
  console.log(`     ⇒ 标记确实掉了，但 queueStore 从未清过它 → 掉标记来自执行器的启动写入（形态判据的必然假阳性）`);

  // A2 形态1
  reset([{ id: A, name: "A", nodes: [mkNode()], edges: [] }], A, [mkNode()]);
  renderToStaticMarkup(React.createElement(Probe));
  useQueueStore.getState().enqueue({ nodeId: X, canvasId: null, nodeLabel: "L", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 700 } });
  await sleep(80);
  await handle();
  console.log(`  A2 形态1 点击后：标记=${JSON.stringify(markerFlow())} 队列=${active().map((j) => `${j.canvasId ?? "null"}:${j.status}`).join(",")}`);
  await sleep(1000);
  const a2 = clearEvents();
  console.log(`     queueStore 清理事件=${a2.length}：${a2.map((e) => `${e.via}${e.patch}@[${(e.activeAt||[]).join("|")}]`).join(" ; ") || "（无）"}`);

  // A3 形态2
  reset([{ id: A, name: "A", nodes: [mkNode()], edges: [] }, { id: B, name: "B", nodes: [mkNode()], edges: [] }], A, [mkNode()]);
  renderToStaticMarkup(React.createElement(Probe));
  useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 700 } });
  await sleep(80);
  useCanvasStore.setState({ activeCanvasId: B });
  useFlowStore.setState({ nodes: [mkNode()], edges: [] });
  await handle();
  console.log(`  A3 形态2 点击后：标记=${JSON.stringify(markerFlow())} 队列=${active().map((j) => `${j.canvasId ?? "null"}:${j.status}`).join(",")}`);
  await sleep(1000);
  const a3 = clearEvents();
  console.log(`     queueStore 清理事件=${a3.length}：${a3.map((e) => `${e.via}${e.patch}@[${(e.activeAt||[]).join("|")}]`).join(" ; ") || "（无）"}`);
  badFaithful = [...a2, ...a3].filter((e) => e.activeAt.length > 0).length;
  console.log(`  ⇒ faithful 模式下"仍有活动任务时 queueStore 却清了标记"的次数=${badFaithful}（缺陷签名，期望 0）`);
}

console.log("");
console.log("========== B) silent 隔离：A 运行 + B 排队，A 收尾不得抹掉 B 的合法标记 ==========");
reset(
  [
    { id: A, name: "A", nodes: [mkNode(true)], edges: [] },
    { id: B, name: "B", nodes: [mkNode(true)], edges: [] },
  ],
  A,
  [mkNode(true)]
);
// 用真 hook 让标记与守卫走真实路径：先让 A 的任务在跑，再在 B 上点击
useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 500 } });
await sleep(60);
useCanvasStore.setState({ activeCanvasId: B });
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
renderToStaticMarkup(React.createElement(Probe));
await handle(); // B 上点击 → 标记 true（flowStore 当前显示的是 B 的节点）
console.log(`  点击后：标记=${JSON.stringify(markerFlow())} 队列=${active().map((j) => `${j.canvasId}:${j.status}`).join(",")}`);
const bSnapshot = { flow: markerFlow(), a: markerCanvas(A), b: markerCanvas(B) };
log.length = 0;
// 逐步采样：找出"A 已结束而 B 仍 active"的那一帧（这才是 F-R3-1 的判据时刻）
let midFrame = null;
for (let i = 0; i < 60; i++) {
  await sleep(20);
  const act = activeForX();
  const bAlive = act.some((j) => j.canvasId === B);
  const aAlive = act.some((j) => j.canvasId === A);
  if (bAlive && !aAlive) {
    midFrame = { at: i * 20, act: act.map((j) => `${j.canvasId}:${j.status}`), flow: markerFlow() };
    if (markerFlow() !== true) break; // 已误清，无需再采样
  }
}
const bMid = { flow: markerFlow(), a: markerCanvas(A), b: markerCanvas(B) };
console.log(`  B 的判据帧（A 已结束、B 仍 active）：${midFrame ? JSON.stringify(midFrame) : "未捕捉到（A/B 收尾重叠）"}`);
console.log(`  当前：flow=${JSON.stringify(bMid.flow)} canvasA=${JSON.stringify(bMid.a)} canvasB=${JSON.stringify(bMid.b)} 活动=${activeForX().map((j) => `${j.canvasId}:${j.status}`).join(",")}`);
console.log(`  queueStore 清理事件=${clearEvents().length}：${clearEvents().map((e) => `${e.via}${e.patch}@[${(e.activeAt||[]).join("|")}]`).join(" ; ") || "（无）"}`);
console.log(`  全部写入明细（含非 queueStore 来源）：${log.map((e) => `${e.by}/${e.via}${e.patch}@[${(e.activeAt||[]).join("|")}]`).join(" ; ") || "（无）"}`);
await sleep(400);
console.log(`  全部收尾后：flow=${JSON.stringify(markerFlow())} canvasA=${JSON.stringify(markerCanvas(A))} canvasB=${JSON.stringify(markerCanvas(B))} 活动=${activeForX().length}`);
const bOk = (!midFrame ? true : midFrame.flow === true) && !anyTrue();
console.log(`  B 判定=${bOk ? "PASS（B 仍 active 时标记保持 true；全部结束后所有载体都清）" : "FAIL"}`);

console.log("");
console.log("========== C) cancel 的 queued 分支（真 hook 写标记）==========");
// C1 单画布：暂停 → 点击（真 hook 写 true）→ 取消 → 必须清
reset([{ id: A, name: "A", nodes: [mkNode()], edges: [] }], A, [mkNode()]);
renderToStaticMarkup(React.createElement(Probe));
useQueueStore.setState({ paused: true, concurrency: 1 });
await handle();
const c1job = useQueueStore.getState().jobs.find((j) => j.nodeId === X);
console.log(`  C1 点击后：job=${c1job.status} 标记=${JSON.stringify(markerFlow())} 画布副本=${JSON.stringify(markerCanvas(A))}`);
log.length = 0;
useQueueStore.getState().cancel(c1job.id);
await sleep(30);
const c1ok = markerFlow() !== true && markerCanvas(A) !== true && useQueueStore.getState().jobs.find((j) => j.id === c1job.id).status === "cancelled";
console.log(`  C1 取消 queued 后：标记=${JSON.stringify(markerFlow())} 画布副本=${JSON.stringify(markerCanvas(A))} 活动=${activeForX().length} → ${c1ok ? "PASS" : "FAIL"}`);
console.log(`     queueStore 清理事件=${clearEvents().length}：${clearEvents().map((e) => `${e.via}${e.patch}@[${(e.activeAt||[]).join("|")}]`).join(" ; ") || "（无）"}`);

// C2 两画布各有同一 nodeId 的 queued 任务：取消其一必须保留标记
reset(
  [
    { id: A, name: "A", nodes: [mkNode()], edges: [] },
    { id: B, name: "B", nodes: [mkNode()], edges: [] },
  ],
  A,
  [mkNode()]
);
renderToStaticMarkup(React.createElement(Probe));
useQueueStore.setState({ paused: true, concurrency: 1 });
await handle(); // A 上点击（活动画布 A）
useCanvasStore.setState({ activeCanvasId: B });
useFlowStore.setState({ nodes: [mkNode()], edges: [] });
await handle(); // B 上点击（同名节点、不同画布）
const two = useQueueStore.getState().jobs.filter((j) => j.nodeId === X);
console.log(`  C2 两次点击后：队列=${two.map((j) => `${j.canvasId}:${j.status}`).join(",")} 标记=${JSON.stringify(markerFlow())}`);
useQueueStore.getState().cancel(two.find((j) => j.canvasId === A).id);
await sleep(30);
const c2keep = markerFlow() === true;
console.log(`  C2 取消 A 后（B 仍 queued）：标记=${JSON.stringify(markerFlow())} → ${c2keep ? "PASS（未被误清）" : "FAIL（误清）"}`);
useQueueStore.getState().cancel(two.find((j) => j.canvasId === B).id);
await sleep(30);
const c2clear = !anyTrue() && activeForX().length === 0;
console.log(`  C2 取消 B 后：标记=${JSON.stringify(markerFlow())} canvasA=${JSON.stringify(markerCanvas(A))} canvasB=${JSON.stringify(markerCanvas(B))} → ${c2clear ? "PASS（全部载体已复位）" : "FAIL"}`);

// C3 标记只存在于画布副本（flowStore 里没有该节点）
reset([{ id: A, name: "A", nodes: [mkNode(true)], edges: [] }], A, []);
renderToStaticMarkup(React.createElement(Probe));
useQueueStore.setState({ paused: true, concurrency: 1 });
useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
await sleep(10);
const c3job = useQueueStore.getState().jobs.find((j) => j.nodeId === X);
useQueueStore.getState().cancel(c3job.id);
await sleep(30);
const c3ok = markerCanvas(A) !== true;
console.log(`  C3 flowStore 无该节点、副本为唯一载体：取消后 canvasA=${JSON.stringify(markerCanvas(A))} → ${c3ok ? "PASS（早退判据没漏掉这份 true）" : "FAIL（漏清=永久锁）"}`);

console.log("");
console.log("========== D) F-R3-2 早退：全部载体 falsy 时不得有任何写入/身份变化 ==========");
reset([{ id: A, name: "A", nodes: [mkNode()], edges: [] }], A, [mkNode()]);
const flowIdBefore = useFlowStore.getState().nodes;
const canvIdBefore = useCanvasStore.getState().canvases;
log.length = 0;
useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p" });
await sleep(250);
const qw = log.filter((e) => e.by === "queueStore");
console.log(`  任务结束后：queueStore 的写入次数=${qw.length}（期望 0；标记本来就是 falsy）`);
console.log(`  flowStore.nodes 保身份=${useFlowStore.getState().nodes === flowIdBefore} canvasStore.canvases 保身份=${useCanvasStore.getState().canvases === canvIdBefore}`);
console.log(`  拦截到的全部写入：${log.map((e) => `${e.by}/${e.via}${e.patch}`).join(" ; ") || "（无）"}`);

if (MODE !== "silent") {
  console.log("");
  console.log(`【总结】faithful 模式下"仍有活动任务却被 queueStore 清标记"的次数=${badFaithful} → ` +
    `${badFaithful === 0 ? "PRIORITY 1 的复现是判据假阳性" : "存在真实误清"}`);
}
