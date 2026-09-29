/**
 * 审查者自写探针（TASK-003 r2）—— 独立复现 r1 的 queued 标记缺陷场景
 *
 * 背景：r1 判定 FAIL 的唯一 finding 是「工作流路径复用执行器后，启动时无条件写 queued:false，
 * 抹掉了合法的排队标记」。实现方声称用 clearQueuedMarker（默认 false）+ queueStore.pump() 传 true
 * 修好了。本探针**不采信**该说法，按 r1 描述的触发条件亲自构造场景并观察两棵树。
 *
 * 覆盖：
 *   A) 队列被暂停（paused=true），该节点确有一个 queued 任务 → 跑工作流路径
 *   B) 全局额度被外部占满 → 跑工作流路径
 *   C) 队列路径（clearQueuedMarker:true）→ 标记应被清除（既有语义不能丢）
 *   D) 自愈订阅顺序陷阱：先写标记再建 job（应被当陈旧清掉，属正确行为）；先建 job 再写标记（应保留）
 *   每个场景都同时读 **flowStore（活动画布）** 与 **canvasStore 画布副本**。
 *
 * 运行：NC_ROOT=<被测树> node --experimental-strip-types probe-queued-marker-r2.mjs
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = process.env.NC_ROOT
  ? path.resolve(process.env.NC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");
const LABEL = process.env.NC_LABEL || "(unlabeled)";
const HAS_LIMITER = existsSync(path.join(SRC, "services/concurrencyLimiter.ts"));

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.__NC_STORE_SEED__ = {};

const STUBS = {
  "@xyflow/react": `export const ReactFlow=()=>null;export const Background=()=>null;export const Controls=()=>null;
    export const MiniMap=()=>null;export const Panel=()=>null;export const Handle=()=>null;export const useReactFlow=()=>({});
    export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;export const addEdge=(e,es)=>es;
    export const MarkerType={};export const Position={};export const ConnectionLineType={};export const SelectionMode={};
    export const useStore=()=>({});export const getBezierPath=()=>["","",0,0];export const BaseEdge=()=>null;
    export const EdgeLabelRenderer=()=>null;export const useNodes=()=>[];export const useEdges=()=>[];export default {};`,
  "@tauri-apps/api/core": `export const invoke=async()=>{throw new Error("stub invoke");};
    export const Channel=class{};export const convertFileSrc=(p)=>p;export default {};`,
  "@tauri-apps/api/event": `export const listen=async()=>()=>{};export const emit=async()=>{};export default {};`,
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}
    async get(k){return (globalThis.__NC_STORE_SEED__||{})[k] ?? null;}
    async set(){}async save(){}async delete(){}async keys(){return [];}}
    export const load=async()=>new Store();export default {load};`,
  "@tauri-apps/plugin-fs": `export const readFile=async()=>new Uint8Array();export const writeFile=async()=>{};export const exists=async()=>false;export const mkdir=async()=>{};export const remove=async()=>{};export const stat=async()=>({});export default {};`,
  "@tauri-apps/plugin-dialog": `export const open=async()=>null;export const save=async()=>null;export const message=async()=>{};export const ask=async()=>false;export const confirm=async()=>false;export default {};`,
  "@tauri-apps/plugin-opener": `export const openUrl=async()=>{};export const openPath=async()=>{};export const revealItemInDir=async()=>{};export default {};`,
};

function withTs(p) {
  if (existsSync(p) && path.extname(p)) return p;
  for (const c of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) {
    if (existsSync(c)) return c;
  }
  return p;
}

registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGeneration") return { url: "mutant:gen-probe", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const base = fileURLToPath(new URL(spec, context.parentURL));
      const t = withTs(base);
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:gen-probe") {
      return {
        format: "module",
        source: `
          const fake = { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="], text: "p" };
          export const generateImage = async () => fake;
          export const editImage = async () => fake;
          export default {};
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);
const { nodeExecutor } = await import(pathToFileURL(path.join(SRC, "services/nodeExecutor.ts")).href);
// 队列路径的直接调用（与 queueStore.pump() 的调用方式一致）
const { executeImageGeneration } = await import(
  pathToFileURL(path.join(SRC, "services/imageGenerationExecution.ts")).href
);
const limiter = HAS_LIMITER
  ? await import(pathToFileURL(path.join(SRC, "services/concurrencyLimiter.ts")).href)
  : null;

const NODE = "mk-node";
const CANVAS = "mk-canvas";
const makeData = (queued) => ({ ...getDefaultImageGeneratorData(), prompt: "marker probe", queued });

function readMarkers() {
  const f = useFlowStore.getState().nodes.find((n) => n.id === NODE);
  const c = useCanvasStore.getState().canvases.find((x) => x.id === CANVAS);
  const cn = c && c.nodes.find((n) => n.id === NODE);
  return {
    flow: f && f.data ? f.data.queued : undefined,
    canvas: cn && cn.data ? cn.data.queued : undefined,
  };
}

function seed({ queued, jobsBefore }) {
  useQueueStore.setState({ paused: false, concurrency: 2, jobs: [] });
  useFlowStore.setState({ nodes: [], edges: [] });
  useCanvasStore.setState({ activeCanvasId: CANVAS, canvases: [{ id: CANVAS, name: "mk", nodes: [], edges: [] }] });
  // ⚠ 夹具顺序：queueStore 的自愈订阅只在"该 nodeId 有活动任务"时保留标记；
  //   它只清不置位，所以先建 job 再写节点数据（否则标记会被当陈旧清掉）。
  if (jobsBefore) {
    useQueueStore.setState({
      jobs: [
        {
          id: "mk-job",
          nodeId: NODE,
          canvasId: CANVAS,
          nodeLabel: "MK",
          modelLabel: "m",
          promptPreview: "p",
          status: "queued",
          createdAt: Date.now(),
        },
      ],
    });
  }
  useFlowStore.setState({
    nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: makeData(queued) }],
    edges: [],
  });
  useCanvasStore.setState({
    activeCanvasId: CANVAS,
    canvases: [
      {
        id: CANVAS,
        name: "mk",
        nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: makeData(queued) }],
        edges: [],
      },
    ],
  });
}

function report(desc, pre, post, extra = "") {
  console.log("");
  console.log("### " + desc);
  console.log(`  前置: flow=${JSON.stringify(pre.flow)} canvas=${JSON.stringify(pre.canvas)}`);
  console.log(`  后置: flow=${JSON.stringify(post.flow)} canvas=${JSON.stringify(post.canvas)}`);
  const flowKept = post.flow === true;
  const canvasKept = post.canvas === true;
  console.log(`  工作流路径是否保住标记: flow=${flowKept} canvas=${canvasKept}`);
  if (extra) console.log("  " + extra);
}

console.log("=".repeat(78));
console.log(`LABEL=${LABEL}  hasLimiter=${HAS_LIMITER}`);
console.log("=".repeat(78));

// ---------- A) 队列被暂停 + 该节点确有 queued 任务 → 工作流路径 ----------
{
  seed({ queued: true, jobsBefore: true });
  useQueueStore.setState({ paused: true });
  const pre = readMarkers();
  await nodeExecutor.executeNode(useFlowStore.getState().nodes.find((n) => n.id === NODE), CANVAS);
  await new Promise((r) => setTimeout(r, 50));
  const jobs = useQueueStore.getState().jobs.map((j) => j.status);
  // 合法性核对：该 nodeId 是否真的还有活动任务
  const active = useQueueStore.getState().jobs.some((j) => j.nodeId === NODE && (j.status === "queued" || j.status === "running"));
  report("A) 队列暂停(paused) + 该节点有 queued 任务 → 工作流路径", pre, readMarkers(), `队列 jobs=${JSON.stringify(jobs)} 该节点仍有活动任务=${active}`);
}

// ---------- B) 全局额度被外部占满 → 工作流路径 ----------
{
  seed({ queued: true, jobsBefore: true });
  useQueueStore.setState({ paused: true });
  let ext = null;
  if (limiter) {
    limiter.resetGlobalConcurrencyLimiter();
    limiter.setGlobalConcurrencyLimit(1);
    ext = limiter.tryAcquireGlobalSlot();
  }
  const pre = readMarkers();
  await nodeExecutor.executeNode(useFlowStore.getState().nodes.find((n) => n.id === NODE), CANVAS);
  await new Promise((r) => setTimeout(r, 50));
  report("B) 全局额度被外部占满 + 该节点有 queued 任务 → 工作流路径", pre, readMarkers(),
    `外部占额度成功=${Boolean(ext)} 在途=${limiter ? limiter.getInFlightCount() : "n/a"}`);
  if (ext) ext();
  if (limiter) limiter.resetGlobalConcurrencyLimiter();
}

// ---------- C) 队列路径（clearQueuedMarker:true）→ 标记应被清除 ----------
{
  seed({ queued: true, jobsBefore: true });
  const pre = readMarkers();
  await executeImageGeneration(NODE, { canvasId: CANVAS, withRunRecords: true, clearQueuedMarker: true });
  await new Promise((r) => setTimeout(r, 50));
  report("C) 队列路径调用方式（clearQueuedMarker:true）", pre, readMarkers(), "期望：两处均为 falsy（既有语义）");
}

// ---------- D) 自愈顺序陷阱：先写标记、后建 job ----------
{
  // 故意反过来：先写节点数据（queued:true），此时没有任何活动任务 → 自愈会把它当陈旧清掉
  useQueueStore.setState({ paused: true, concurrency: 2, jobs: [] });
  useFlowStore.setState({ nodes: [], edges: [] });
  useCanvasStore.setState({ activeCanvasId: CANVAS, canvases: [{ id: CANVAS, name: "mk", nodes: [], edges: [] }] });
  useFlowStore.setState({
    nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: makeData(true) }],
    edges: [],
  });
  const afterNodeWrite = readMarkers();
  useQueueStore.setState({
    jobs: [{ id: "mk-job2", nodeId: NODE, canvasId: CANVAS, nodeLabel: "MK", modelLabel: "m", promptPreview: "p", status: "queued", createdAt: Date.now() }],
  });
  const afterJob = readMarkers();
  console.log("");
  console.log("### D) 自愈顺序陷阱（先写标记→后建 job）");
  console.log(`  写节点数据后: flow=${JSON.stringify(afterNodeWrite.flow)}（自愈只清不置位，无活动任务时被清掉属正确行为）`);
  console.log(`  再建 job 后 : flow=${JSON.stringify(afterJob.flow)}（不会自动置位回 true）`);
}

// ---------- E) 工作流路径后，队列把任务跑起来 → 执行器启动时清标记（队列路径语义） ----------
{
  seed({ queued: false, jobsBefore: true });
  useQueueStore.setState({ paused: false, concurrency: 2 });
  useQueueStore.getState().pump();
  const sawDuringRun = [];
  for (let i = 0; i < 40; i++) {
    sawDuringRun.push(readMarkers().flow);
    await new Promise((r) => setTimeout(r, 25));
  }
  const jobs = useQueueStore.getState().jobs.map((j) => `${j.id}:${j.status}`);
  console.log("");
  console.log("### E) 真实队列路径 pump() 驱动");
  console.log(`  队列 jobs=${JSON.stringify(jobs)}`);
  console.log(`  flow.queued 采样序列=${JSON.stringify([...new Set(sawDuringRun.map(String))])}（终态=${JSON.stringify(readMarkers().flow)}）`);
  console.log(`  全局在途残留=${limiter ? limiter.getInFlightCount() : "n/a"}`);
}

console.log("");
console.log("=".repeat(78));
console.log(`DONE LABEL=${LABEL}`);
