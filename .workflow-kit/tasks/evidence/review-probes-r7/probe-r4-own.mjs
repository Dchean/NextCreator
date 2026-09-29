/**
 * 独立审查探针 R4（TASK-006 第四轮）—— 审查者自己写的，不复用 worker 的控制探针结论。
 *
 *  A) 归因：用**调用栈**判定每一次节点写入来自 queueStore 还是执行器，
 *     回答"标记消失时是否仍有同 nodeId 的活动任务"（PRIORITY 1）。
 *  B) cancel 的 queued 分支（paused 时任务停在 queued）是否真的复位标记（PRIORITY 2）。
 *  C) 一次 setState 清多载体：无关节点/边/画布是否被保身份，早退判据的三种边界（PRIORITY 2）。
 *
 * 用法：node --experimental-strip-types probe-r4-own.mjs
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

// 忠实执行器：开始时写 status=loading + queued:false（与真实执行器同形）
const EXEC_SRC = `
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
const Y = "gen-y";
const A = "canvas-a";
const B = "canvas-b";
const mkNode = (id = X) => ({
  id,
  type: "imageGeneratorNode",
  position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: `L-${id}` },
});

let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution(X, useFlowStore.getState().nodes[0].data);
  handle = handleGenerate;
  return null;
}

const activeJ = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");
const activeForX = () => activeJ().filter((j) => j.nodeId === X);
const canRun = (d) => Boolean(d.prompt) && d.status !== "loading" && !(d.queued === true);
const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const markerCanvas = (cid) =>
  useCanvasStore.getState().canvases.find((c) => c.id === cid)?.nodes.find((n) => n.id === X)?.data?.queued;

// ——— 写入监控：栈归因 ———
const writes = []; // {from, patch, activeForX, stackTop}
function instrument() {
  const origUpdate = useFlowStore.getState().updateNodeData;
  useFlowStore.setState({
    updateNodeData: (id, patch) => {
      const stack = String(new Error().stack || "");
      writes.push({
        from: /queueStore\.ts/.test(stack) ? "queueStore" : "other",
        nodeId: id,
        keys: Object.keys(patch || {}).sort().join(","),
        values: JSON.stringify(patch),
        activeForX: activeForX().map((j) => `${j.canvasId ?? "null"}:${j.status}`),
      });
      return origUpdate(id, patch);
    },
  });
  const origSetState = useCanvasStore.setState;
  useCanvasStore.setState = (partial, replace) => {
    const stack = String(new Error().stack || "");
    writes.push({
      from: /queueStore\.ts/.test(stack) ? "queueStore" : "other",
      nodeId: "(canvasStore)",
      keys: Object.keys(partial || {}).sort().join(","),
      values: "canvasStore.setState",
      activeForX: activeForX().map((j) => `${j.canvasId ?? "null"}:${j.status}`),
    });
    return origSetState(partial, replace);
  };
}
/** queueStore 造成的 queued 清除里，有多少次当时**仍有同 nodeId 的活动任务**（真缺陷签名） */
const badClears = () =>
  writes.filter((w) => w.from === "queueStore" && /queued/.test(w.values) && w.activeForX.length > 0);

function reset(canvases, activeCanvasId, flowNodes) {
  useCanvasStore.setState({ canvases, activeCanvasId, _hasHydrated: true });
  useFlowStore.setState({ nodes: flowNodes, edges: [] });
  useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
}

async function caseA() {
  console.log("========== A) 归因：标记消失时是否仍有同 nodeId 的活动任务 ==========");
  console.log("--- A1 单画布单节点（100% 正确实现也必然触发那条判据的对照组）---");
  reset([{ id: A, name: "A", nodes: [mkNode()], edges: [] }], A, [mkNode()]);
  writes.length = 0;
  renderToStaticMarkup(React.createElement(Probe));
  await handle();
  console.log(`  点击后标记=${JSON.stringify(marker())} 活动=${activeForX().length}`);
  await sleep(300);
  const qw = writes.filter((w) => w.from === "queueStore");
  console.log(`  queueStore 写入次数=${qw.length}  其中"仍有活动任务时清 queued"=${badClears().length}`);
  console.log(`  标记终值=${JSON.stringify(marker())}`);

  console.log("--- A2 形态1：canvasId=null 遗留任务 vs 活动画布上的排队任务 ---");
  reset([{ id: A, name: "A", nodes: [mkNode()], edges: [] }], A, [mkNode()]);
  writes.length = 0;
  useQueueStore.getState().enqueue({
    nodeId: X, canvasId: null, nodeLabel: "X", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 700 },
  });
  await sleep(80);
  await handle();
  console.log(`  点击后：标记=${JSON.stringify(marker())} 队列=${useQueueStore.getState().jobs.map((j) => `${j.canvasId ?? "null"}:${j.status}`).join(",")}`);
  await sleep(1000);
  const q2 = writes.filter((w) => w.from === "queueStore");
  console.log(`  queueStore 的节点写入：${q2.map((w) => `${w.nodeId}${w.values}@[${w.activeForX.join("|")}]`).join(" ; ") || "（无）"}`);
  console.log(`  ⇒ 仍有活动任务时的 queueStore 清除次数=${badClears().length}（期望 0）`);

  console.log("--- A3 形态2：复制画布（同名 nodeId）---");
  reset(
    [
      { id: A, name: "A", nodes: [mkNode()], edges: [] },
      { id: B, name: "B", nodes: [mkNode()], edges: [] },
    ],
    A,
    [mkNode()]
  );
  writes.length = 0;
  useQueueStore.getState().enqueue({
    nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p", dataOverride: { delayMs: 700 },
  });
  await sleep(80);
  useCanvasStore.setState({ activeCanvasId: B });
  useFlowStore.setState({ nodes: [mkNode()], edges: [] });
  await handle();
  console.log(`  点击后：标记=${JSON.stringify(marker())} 队列=${useQueueStore.getState().jobs.map((j) => `${j.canvasId ?? "null"}:${j.status}`).join(",")}`);
  await sleep(1000);
  const q3 = writes.filter((w) => w.from === "queueStore");
  console.log(`  queueStore 的节点写入：${q3.map((w) => `${w.nodeId}${w.values}@[${w.activeForX.join("|")}]`).join(" ; ") || "（无）"}`);
  console.log(`  ⇒ 仍有活动任务时的 queueStore 清除次数=${badClears().length}（期望 0）`);
  console.log(`  终值：flowStore=${JSON.stringify(marker())} canvas[A]=${JSON.stringify(markerCanvas(A))} canvas[B]=${JSON.stringify(markerCanvas(B))}`);
  return badClears().length;
}

async function caseB() {
  console.log("");
  console.log("========== B) cancel 的 queued 分支是否复位标记（该路径没有 .finally）==========");
  reset(
    [
      { id: A, name: "A", nodes: [mkNode()], edges: [] },
      { id: B, name: "B", nodes: [mkNode()], edges: [] },
    ],
    A,
    [mkNode()]
  );
  renderToStaticMarkup(React.createElement(Probe));
  // 暂停 → 点击后任务停在 queued（永不进入执行器 → 永远没有 pump.finally）
  useQueueStore.setState({ paused: true, concurrency: 1 });

  // B1：单画布：点击 → 排队 → 取消
  await handle();
  const j1 = useQueueStore.getState().jobs.find((j) => j.nodeId === X);
  console.log(`  B1 点击后：job=${j1.status} 标记=${JSON.stringify(marker())} 按钮可用=${canRun(useFlowStore.getState().nodes[0].data)}`);
  useQueueStore.getState().cancel(j1.id);
  await sleep(30);
  console.log(`  B1 取消后：job=${useQueueStore.getState().jobs.find((j) => j.id === j1.id).status} 标记=${JSON.stringify(marker())} ` +
    `canvas[A]=${JSON.stringify(markerCanvas(A))} 按钮可用=${canRun(useFlowStore.getState().nodes[0].data)} 活动=${activeForX().length}`);
  const b1 = marker() === false && markerCanvas(A) === false;

  // B2：两画布各有同一 nodeId 的 queued 任务，取消其一 → 标记必须保持 true；取消其二 → 清
  useFlowStore.setState({ nodes: [mkNode()], edges: [] });
  useCanvasStore.setState({
    canvases: [
      { id: A, name: "A", nodes: [mkNode()], edges: [] },
      { id: B, name: "B", nodes: [mkNode()], edges: [] },
    ],
    activeCanvasId: A,
  });
  useQueueStore.setState({ jobs: [], paused: true });
  await handle(); // 画布 A 的 queued（flowStore 标记 true）
  useCanvasStore.setState({ activeCanvasId: B });
  useFlowStore.setState({ nodes: [mkNode()], edges: [] });
  await handle(); // 画布 B 的 queued（同名 nodeId）
  const two = useQueueStore.getState().jobs.filter((j) => j.nodeId === X);
  console.log(`  B2 两次点击后：队列=${two.map((j) => `${j.canvasId}:${j.status}`).join(",")} 标记=${JSON.stringify(marker())}`);
  useQueueStore.getState().cancel(two.find((j) => j.canvasId === A).id);
  await sleep(20);
  console.log(`  B2 取消 A 后：标记=${JSON.stringify(marker())}（B 仍在 queued → 必须保持 true）活动=${activeForX().length}`);
  const b2a = marker() === true;
  useQueueStore.getState().cancel(two.find((j) => j.canvasId === B).id);
  await sleep(20);
  console.log(`  B2 再取消 B 后：标记=${JSON.stringify(marker())} canvas[A]=${JSON.stringify(markerCanvas(A))} canvas[B]=${JSON.stringify(markerCanvas(B))} 活动=${activeForX().length}`);
  const b2b = marker() === false && markerCanvas(A) === false && markerCanvas(B) === false;
  console.log(`  B1（单画布 queued 取消应清）=${b1 ? "PASS" : "FAIL"}  B2a（另一画布仍有 queued 时须保留）=${b2a ? "PASS" : "FAIL"}  B2b（全部取消后须清空所有载体）=${b2b ? "PASS" : "FAIL"}`);
  return b1 && b2a && b2b;
}

async function caseC() {
  console.log("");
  console.log("========== C) 多载体单次 setState 的保身份 / 早退边界 ==========");
  const sibling = mkNode(Y);
  sibling.data.custom = { keep: 1 };
  const canvasBNode = mkNode(Y);
  const edgesA = [{ id: "e1", source: Y, target: X }];
  reset(
    [
      { id: A, name: "A", nodes: [mkNode(), sibling], edges: edgesA, extra: "keep-me" },
      { id: B, name: "B", nodes: [canvasBNode], edges: [] },
    ],
    A,
    [mkNode(), sibling]
  );
  // 预置"落盘副本上的陈旧 true"（模拟上一轮把 true 写进 canvasStore 的情形）
  useCanvasStore.setState((s) => ({
    canvases: s.canvases.map((c) => ({
      ...c,
      nodes: c.nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)),
    })),
  }));

  console.log("--- C1 早退边界1：flowStore 已是 false、画布副本是 true（必须仍清画布）---");
  useFlowStore.getState().updateNodeData(X, { queued: false });
  const beforeC = useCanvasStore.getState().canvases;
  const siblingBefore = beforeC.find((c) => c.id === A).nodes.find((n) => n.id === Y);
  const edgesBefore = beforeC.find((c) => c.id === A).edges;
  const canvasBBefore = beforeC.find((c) => c.id === B);
  // 让唯一活动任务结束来触发清除（谓词放行）
  useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p" });
  await sleep(200);
  const afterC = useCanvasStore.getState().canvases;
  const cA = afterC.find((c) => c.id === A);
  console.log(`  canvas[A].queued=${JSON.stringify(cA.nodes.find((n) => n.id === X)?.data?.queued)}（期望 false）`);
  console.log(`  兄弟节点保身份=${cA.nodes.find((n) => n.id === Y) === siblingBefore}  自定义字段=${JSON.stringify(cA.nodes.find((n) => n.id === Y)?.data.custom)}`);
  console.log(`  edges 保身份=${cA.edges === edgesBefore}  画布额外字段=${JSON.stringify(cA.extra)}  无关画布保身份=${afterC.find((c) => c.id === B) === canvasBBefore}`);

  console.log("--- C2 早退边界2：flowStore 无该节点、画布副本是 true（冷启动后另一画布）---");
  useFlowStore.setState({ nodes: [mkNode(Y)], edges: [] });
  useCanvasStore.setState((s) => ({
    canvases: s.canvases.map((c) => ({
      ...c,
      nodes: c.nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)),
    })),
  }));
  useFlowStore.getState().updateNodeData(Y, { queued: true });
  useQueueStore.setState({ jobs: [], paused: false });
  useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p" });
  await sleep(200);
  console.log(`  清除后 canvas[A].queued=${JSON.stringify(markerCanvas(A))} canvas[B].queued=${JSON.stringify(markerCanvas(B))}（期望均 false）`);

  console.log("--- C3 早退边界3：两者都是 falsy → 不得产生任何身份变化 ---");
  reset([{ id: A, name: "A", nodes: [mkNode()], edges: [] }], A, [mkNode()]);
  const flowBefore = useFlowStore.getState().nodes;
  const canvBefore = useCanvasStore.getState().canvases;
  useQueueStore.getState().enqueue({ nodeId: X, canvasId: A, nodeLabel: "X", modelLabel: "m", promptPreview: "p" });
  await sleep(200);
  console.log(`  nodes 保身份=${useFlowStore.getState().nodes === flowBefore}  canvases 保身份=${useCanvasStore.getState().canvases === canvBefore}`);
  console.log(`  标记=${JSON.stringify(marker())}（应 false/undefined，且不产生无谓写入）`);
}

const bad = await caseA();
const okB = await caseB();
await caseC();
console.log("");
console.log(`【A 结论】仍有活动任务时的 queueStore 清除次数 = ${bad} → ${bad === 0 ? "不存在误清（PRIORITY 1 判据为假阳性）" : "存在真实误清"}`);
console.log(`【B 结论】cancel 的 queued 分支三条断言 = ${okB ? "全部 PASS" : "有 FAIL"}`);
