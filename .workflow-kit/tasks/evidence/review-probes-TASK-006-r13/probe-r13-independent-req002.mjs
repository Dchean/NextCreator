/**
 * 独立审查探针（TASK-006 r13，审查者自写，只读产品代码，不修改任何仓库文件）
 *
 * 目的：不走 scripts/queue-regression.mjs 的用例，独立驱动**真实** queueStore.enqueue 守卫与
 *       **真实** useImageGeneratorExecution.handleGenerate，验证四项与验收标准直接相关、但门禁用例
 *       覆盖较弱的性质：
 *         T1 同一 tick 内两次点击（完全不 await）只产生 1 个 job；
 *         T2 queueStore.paused=true 时连点仍只产生 1 个 job（暂停态不得跳过守卫）；
 *         T3 不同节点的并发不被拒绝（禁止全局单飞）；
 *         T4 历史终态任务不锁死该节点的再次生成。
 *
 * 与产品行为有关的依赖桩（如实记录，均与本文件外的一致性由读源码确认）：
 *   · @xyflow/react、@tauri-apps/* 为浏览器/Tauri 运行时的替代桩（与门禁、历史探针同款）；
 *   · @/services/imageGenerationExecution 换成一个"固定 400ms 后成功"的忠实桩：真实执行器在
 *     未配置供应商时几乎立刻失败，会让 job 瞬间离开 active 集合，从而无法观察"活动任务仍在时"
 *     的守卫语义。被审对象（queueStore 守卫 + hook 入队路径）保持真实源码。
 *
 * 用法：node --experimental-strip-types probe-r13-independent-req002.mjs
 * 退出码：全部断言成立 → 0；任一不成立 → 1
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve("D:/NextCreator");
const SRC = path.join(root, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const EXEC_STUB = `
export const executeImageGeneration = async (nodeId, options) => {
  await new Promise((r) => setTimeout(r, 400));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  const { useFlowStore } = await import("@/stores/flowStore");
  const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { success: false, error: "节点不存在" };
  useFlowStore.getState().updateNodeData(nodeId, { status: "success", queued: false });
  return { success: true, cancelled: false };
};
export const getImageBatchCount = (data) =>
  data?.apiProtocol === "openai-images" ? 1 : Math.min(Math.max(data?.n || 1, 1), 4);
`;

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
    async get(){return null;}async set(){}async save(){}async delete(){}async keys(){return [];}}
    export const load=async()=>new Store();export default {load};`,
  "@tauri-apps/plugin-fs": `export const readFile=async()=>new Uint8Array();export const writeFile=async()=>{};
    export const exists=async()=>false;export const mkdir=async()=>{};export const remove=async()=>{};export const stat=async()=>({});export default {};`,
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
    if (spec === "@/services/imageGenerationExecution") return { url: "stub:exec-delayed", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url === "stub:exec-delayed") return { format: "module", source: EXEC_STUB, shortCircuit: true };
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    return nextLoad(url, context);
  },
});

const importRepo = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);
const { useQueueStore } = await importRepo("stores/queueStore.ts");
const { useFlowStore } = await importRepo("stores/flowStore.ts");
const { getDefaultImageGeneratorData } = await importRepo("components/nodes/imageGeneratorConfig.ts");
const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { useImageGeneratorExecution } = await importRepo("hooks/useImageGeneratorExecution.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "  [OK]  " : "  [NG]  "}${name}`);
  console.log(`         ${detail}`);
}

/** 用 renderToStaticMarkup 拿到真实 hook 的 handleGenerate（与门禁用例同法，确保走真实入队路径） */
function mountHook(nodeId) {
  let handle = null;
  function Probe() {
    const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
    const { handleGenerate } = useImageGeneratorExecution(nodeId, node.data);
    handle = handleGenerate;
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return handle;
}

function setNodes(ids) {
  useFlowStore.setState({
    nodes: ids.map((id) => ({
      id,
      type: "imageGeneratorNode",
      position: { x: 0, y: 0 },
      data: { ...getDefaultImageGeneratorData(), prompt: "r13 probe" },
    })),
    edges: [],
  });
}

const jobCount = (nodeId) => useQueueStore.getState().jobs.filter((j) => j.nodeId === nodeId).length;
const activeCount = (nodeId) =>
  useQueueStore.getState().jobs.filter((j) => j.nodeId === nodeId && (j.status === "queued" || j.status === "running")).length;

// ---------------------------------------------------------------------------
console.log("=== T1 同一 tick 内两次点击（互不 await）只产生 1 个 job ===");
setNodes(["r13-n1"]);
useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
const h1 = mountHook("r13-n1");
const p1 = h1();
const p2 = h1(); // 与上一次调用在同一 tick 内、完全不 await
await Promise.all([p1, p2]);
check("T1 同 tick 双点 → 同节点 job 数 == 1", jobCount("r13-n1") === 1, `同节点 job 数=${jobCount("r13-n1")}（期望 1）`);
await sleep(700);
check("T1b 该批跑完后仍只有 1 个 job（无迟到入队）", jobCount("r13-n1") === 1, `同节点 job 数=${jobCount("r13-n1")}`);

// ---------------------------------------------------------------------------
console.log("");
console.log("=== T2 paused=true 时连点仍只产生 1 个 job（暂停不得跳过守卫）===");
setNodes(["r13-n2"]);
useQueueStore.setState({ jobs: [], paused: true, concurrency: 2 });
const h2 = mountHook("r13-n2");
const pa = h2();
const pb = h2();
const pc = h2();
await Promise.all([pa, pb, pc]);
const pausedJobs = useQueueStore.getState().jobs.filter((j) => j.nodeId === "r13-n2");
check(
  "T2 暂停态三连点 → 同节点 job 数 == 1 且仍为 queued（未被派发）",
  pausedJobs.length === 1 && pausedJobs[0].status === "queued",
  `同节点 job 数=${pausedJobs.length}（期望 1）；status=${pausedJobs[0]?.status}（期望 queued，paused=true）`
);
check("T2b 暂停期间节点不会被写坏：paused 仍为 true", useQueueStore.getState().paused === true, `paused=${useQueueStore.getState().paused}`);

// ---------------------------------------------------------------------------
console.log("");
console.log("=== T3 不同节点并发不被拒绝（禁止全局单飞）===");
setNodes(["r13-a", "r13-b"]);
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
const ha = mountHook("r13-a");
const hb = mountHook("r13-b");
await ha();
check("T3a 节点 A 入队成功", jobCount("r13-a") === 1, `A job 数=${jobCount("r13-a")}（期望 1）`);
await hb();
check(
  "T3b 额度被 A 占满时，节点 B 仍可入队（非全局单飞）",
  jobCount("r13-b") === 1,
  `B job 数=${jobCount("r13-b")}（期望 1）；队列总计=${useQueueStore.getState().jobs.length}`
);
const bStatus = useQueueStore.getState().jobs.find((j) => j.nodeId === "r13-b")?.status;
check("T3c 此时 B 的任务处于 queued（额度被 A 占用，未被拒绝、也未并发运行）", bStatus === "queued", `B status=${bStatus}`);

// ---------------------------------------------------------------------------
console.log("");
console.log("=== T4 历史终态任务不锁死节点的再次生成 ===");
await sleep(1400); // 等 A/B 全部进入终态
const before = jobCount("r13-a");
await ha();
check(
  "T4 终态历史任务存在时，同节点再次生成仍被放行（新增 1 个）",
  jobCount("r13-a") === before + 1,
  `A job 数 ${before} → ${jobCount("r13-a")}（期望 +1）`
);
check(
  "T4b 该节点此刻的活动任务数 == 1（历史任务不参与判重，但也不允许并发）",
  activeCount("r13-a") === 1,
  `活动任务数=${activeCount("r13-a")}（期望 1）`
);

const failed = results.filter((r) => !r.ok);
console.log("");
console.log("-".repeat(70));
console.log(`独立探针汇总：${results.length - failed.length}/${results.length} 项成立`);
console.log(`EXIT CODE: ${failed.length === 0 ? 0 : 1}`);
process.exitCode = failed.length === 0 ? 0 : 1;
