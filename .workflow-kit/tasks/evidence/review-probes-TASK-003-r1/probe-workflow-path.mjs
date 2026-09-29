/**
 * 审查者探针 P-workflow（TASK-003 r1 独立审查用；只读，不修改任何产品代码）
 *
 * 目的：门禁用例 G 只是**模拟**工作流路径（自己调用 limiter.tryAcquireGlobalSlot），
 * 并没有真正跑 workflowEngine.executeLayer。本探针补上这一块，核对 REQ-004/REQ-005 在
 * **真实工作流路径**上的行为：
 *   W1 REQ-005：maxParallelNodes=3 但全局额度=1 时，两个同层图片节点的真实在途调用数恒 <= 1
 *               （同一份源码在额度=4 的对照下必须出现 2 路重叠，否则说明探针本身没有区分力）
 *   W2 REQ-005 活性：被额度挡住的那个节点最终仍然执行（排队而不是丢弃）
 *   W3 REQ-004：工作流路径仍把 status/outputImage/outputImagePath/outputImages/outputImagePaths
 *               按既有语义写入节点（成功时 status="success" 且产出非空）
 *   W4 REQ-004：工作流路径**不写** runRecords（withRunRecords:false 的既有语义保持）
 *   W5 REQ-004：抛错时 nodeExecutor 仍返回 {success:false,error}，workflowEngine 节点状态为 failed
 *   W6 REQ-005：工作流结束后全局额度全部归还（inFlight 回到 0，不漏额度）
 *
 * provider 用 resolve/load 钩子替换为"真实实现 + 计数 + 延迟"，因此测的是真实执行链。
 *
 * 运行：node --experimental-strip-types .workflow-kit/tasks/evidence/review-probes-TASK-003-r1/probe-workflow-path.mjs
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(process.cwd());
const SRC = path.join(root, "src");

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

const imageGenUrl = "mutant:probe-imagegen";

registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGeneration") return { url: imageGenUrl, shortCircuit: true };
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
    if (url === imageGenUrl) {
      const real = JSON.stringify(pathToFileURL(path.join(SRC, "services/imageGeneration/index.ts")).href);
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import { generateImage as realGenerateImage, editImage as realEditImage } from ${real};
          export * from ${real};
          const stats = (globalThis.__NC_PROBE__ = globalThis.__NC_PROBE__ || { active: 0, max: 0, calls: 0 });
          async function wrapped(fn, args, behaviour) {
            stats.calls += 1;
            stats.active += 1;
            if (stats.active > stats.max) stats.max = stats.active;
            try {
              await new Promise((r) => setTimeout(r, 250));
              if (behaviour === "throw") throw new Error("probe: provider failure");
              return { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="] };
            } finally {
              stats.active -= 1;
            }
          }
          export const generateImage = async (...args) => wrapped(realGenerateImage, args, globalThis.__NC_PROBE_BEHAVIOUR__);
          export const editImage = async (...args) => wrapped(realEditImage, args, globalThis.__NC_PROBE_BEHAVIOUR__);
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);
const limiter = await import(pathToFileURL(path.join(SRC, "services/concurrencyLimiter.ts")).href);
const { WorkflowEngine } = await import(pathToFileURL(path.join(SRC, "services/workflowEngine.ts")).href);

const CANVAS = "probe-canvas";
const mkNode = (id) => ({
  id,
  type: "imageGeneratorNode",
  position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: `probe ${id}`, model: "gemini-2.5-flash-image" },
});

function seed(nodeIds) {
  const nodes = nodeIds.map(mkNode);
  useFlowStore.setState({ nodes, edges: [] });
  useCanvasStore.setState({
    activeCanvasId: CANVAS,
    canvases: [{ id: CANVAS, name: "probe", nodes, edges: [] }],
  });
  return nodes;
}

async function runWorkflow(nodeIds, limit) {
  const nodes = seed(nodeIds);
  // ⚠ stats 的身份必须稳定：provider 替身在**首次**求值时捕获 globalThis.__NC_PROBE__，
  // 若这里换成新对象，替身会继续写旧对象，读到的是永远为 0 的新对象（探针自身假绿/假红的来源）。
  globalThis.__NC_PROBE__ = globalThis.__NC_PROBE__ || { active: 0, max: 0, calls: 0 };
  globalThis.__NC_PROBE__.active = 0;
  globalThis.__NC_PROBE__.max = 0;
  globalThis.__NC_PROBE__.calls = 0;
  limiter.resetGlobalConcurrencyLimiter();
  limiter.setGlobalConcurrencyLimit(limit);
  const engine = new WorkflowEngine({ maxParallelNodes: 3, skipInputNodes: true });
  const ctx = await engine.executeWorkflow(nodes, [], CANVAS);
  const snapshot = globalThis.__NC_PROBE__;
  const inFlightAfter = limiter.getInFlightCount();
  const data = Object.fromEntries(
    nodeIds.map((id) => [id, useFlowStore.getState().nodes.find((n) => n.id === id)?.data || {}])
  );
  return { ctx, snapshot, inFlightAfter, data };
}

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? "OK  " : "VIOL"}  ${id}  ${detail}`);
};

// ---- 对照：额度=4（两个同层节点应当出现 2 路重叠） --------------------------
const wide = await runWorkflow(["wf-a", "wf-b"], 4);
check("W0-control-overlap", wide.snapshot.max === 2,
  `全局额度=4（maxParallelNodes=3）时两个同层节点的实测峰值在途=${wide.snapshot.max}（期望2，用于证明探针能观察到重叠）`);

// ---- W1 额度=1：真实在途必须被全局额度钳住 ---------------------------------
const tight = await runWorkflow(["wf-a", "wf-b"], 1);
check("W1-global-limit-real-workflow", tight.snapshot.max <= 1,
  `全局额度=1 时真实工作流路径的实测峰值在途=${tight.snapshot.max}（必须<=1；对照额度=4 时为 ${wide.snapshot.max}）`);

// ---- W2 活性：两个节点最终都被执行 -----------------------------------------
check("W2-liveness-both-executed", tight.snapshot.calls === 2 && tight.ctx.progress.completed === 2,
  `provider 调用次数=${tight.snapshot.calls}（期望2）；workflowEngine 进度 completed=${tight.ctx.progress.completed}/2；工作流状态=${tight.ctx.status}`);

// ---- W3 REQ-004：节点产出字段按既有语义写入 --------------------------------
const a = tight.data["wf-a"];
const b = tight.data["wf-b"];
const outputsWritten = (d) =>
  d.status === "success" && Boolean(d.outputImage || d.outputImagePath);
check("W3-node-output-fields", outputsWritten(a) && outputsWritten(b),
  `wf-a: status=${JSON.stringify(a.status)} outputImage=${a.outputImage ? "有" : "无"} outputImagePath=${JSON.stringify(a.outputImagePath)} outputImagePaths=${JSON.stringify(a.outputImagePaths)} outputThumbPath=${JSON.stringify(a.outputThumbPath)}；wf-b 同上 status=${JSON.stringify(b.status)}`);

// ---- W4 REQ-004：工作流路径不写 runRecords ---------------------------------
const noRunRecords = (d) => !d.runRecords || d.runRecords.length === 0;
check("W4-no-run-records-on-workflow-path", noRunRecords(a) && noRunRecords(b),
  `withRunRecords:false 的既有语义：wf-a runRecords=${JSON.stringify(a.runRecords ?? null)}；wf-b runRecords=${JSON.stringify(b.runRecords ?? null)}`);

// ---- W6 额度归还干净 --------------------------------------------------------
check("W6-no-permit-leak", tight.inFlightAfter === 0 && wide.inFlightAfter === 0,
  `工作流结束后全局在途：额度=1 的跑法=${tight.inFlightAfter}；额度=4 的跑法=${wide.inFlightAfter}（均期望0）`);

// ---- W5 失败路径：provider 抛错 --------------------------------------------
globalThis.__NC_PROBE_BEHAVIOUR__ = "throw";
try {
  const fail = await runWorkflow(["wf-fail"], 4);
  const fd = fail.data["wf-fail"];
  check("W5-failure-path",
    fail.ctx.status === "error" && fail.ctx.nodeStatuses["wf-fail"] === "failed" &&
    fd.status === "error" && Boolean(fd.error) && !fd.outputImage && !fd.outputImagePath &&
    fail.inFlightAfter === 0,
    `provider 抛错后：工作流状态=${fail.ctx.status}；节点状态=${fail.ctx.nodeStatuses["wf-fail"]}；节点 data.status=${JSON.stringify(fd.status)}；error=${JSON.stringify(fd.error)}；产出=${fd.outputImage || fd.outputImagePath ? "有（不应有）" : "无（正确）"}；结束后在途=${fail.inFlightAfter}`);
} finally {
  delete globalThis.__NC_PROBE_BEHAVIOUR__;
}

const violated = results.filter((r) => !r.ok);
console.log("");
console.log(`P-workflow 汇总：${results.length - violated.length}/${results.length} 条断言成立`);
if (violated.length > 0) console.log("未成立的断言：" + violated.map((v) => v.id).join(", "));
process.exitCode = violated.length > 0 ? 1 : 0;
console.log(`EXIT CODE: ${process.exitCode}`);
