/**
 * 独立审查探针（TASK-006 / REQ-001）
 *
 * 目的：用**真实冷启动顺序**复现"重启后节点仍显示排队中、按钮禁用"。
 *
 * 与门禁用例 A 的关键差异（这正是可疑点）：
 *   门禁用例 A 在 import queueStore **之前** 就 useFlowStore.setState({nodes:[该节点]})，
 *   即假设"重启后 flowStore 里已经有该节点"。但 flowStore **不持久化**：真实重启后
 *   flowStore.nodes 是空的，节点数据只存在于 canvasStore（持久化），由 App.tsx 的
 *   React effect（App.tsx:121-163 setNodes）在**渲染之后**灌进 flowStore。
 *   本探针不预置 flowStore.nodes，等恢复跑完之后再模拟 App 的 setNodes。
 *
 * 用法：
 *   node --experimental-strip-types probe-req001-coldstart.mjs preload-node   # 门禁式（预置 flowStore）
 *   node --experimental-strip-types probe-req001-coldstart.mjs coldstart      # 真实冷启动（不预置）
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const MODE = process.argv[2] === "preload-node" ? "preload-node" : "coldstart";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");

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
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANVAS_ID = "canvas-active-1";
const NODE_ID = "node-on-active-canvas";
const JOB_ID = "persisted-queued-job-1";

// 重启前的持久化数据（真实重启时磁盘上的两份记录）
globalThis.__NC_STORE_SEED__["next-creator-canvases"] = JSON.stringify({
  state: {
    canvases: [
      {
        id: CANVAS_ID,
        name: "默认画布",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        edges: [],
        nodes: [
          {
            id: NODE_ID,
            type: "imageGeneratorNode",
            position: { x: 0, y: 0 },
            // queued:true 是重启前 useImageGeneratorExecution 写下的"排队中"标记，
            // 经 App.tsx:170 的 subscribe 防抖同步进了画布并落盘
            data: { label: "绘图生成", prompt: "queued before restart", queued: true, n: 1 },
          },
        ],
      },
    ],
    activeCanvasId: CANVAS_ID,
  },
  version: 0,
});

globalThis.__NC_STORE_SEED__["generation-queue"] = JSON.stringify({
  state: {
    jobs: [
      {
        id: JOB_ID,
        nodeId: NODE_ID,
        canvasId: CANVAS_ID,
        nodeLabel: "绘图生成",
        modelLabel: "m",
        promptPreview: "queued before restart",
        status: "queued",
        createdAt: Date.now(),
      },
    ],
    concurrency: 2,
  },
  version: 0,
});

const importRepo = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

// 真实 App 启动时的依赖：App.tsx 先 import canvasStore/flowStore（经 Toolbar 等），
// queueStore 也在同一次模块求值里被 import。这里按 "canvasStore 先" 的顺序（与 import 图一致：
// App.tsx:13 canvasStore / :14 flowStore / Toolbar 内的 queueStore）。
const { useCanvasStore } = await importRepo("stores/canvasStore.ts");
const { useFlowStore } = await importRepo("stores/flowStore.ts");

if (MODE === "preload-node") {
  // —— 门禁用例 A 的假设：重启后 flowStore 里已经有该节点（App.tsx setNodes 的等价物）——
  const canvasNode = useCanvasStore.getState().canvases[0].nodes[0];
  useFlowStore.setState({ nodes: [canvasNode], edges: [] });
  console.log("[setup] preload-node：import queueStore 之前已把节点放进 flowStore（= 门禁用例 A 的假设）");
} else {
  console.log("[setup] coldstart：不预置 flowStore.nodes（真实重启时 flowStore 是空的、不持久化）");
}

// 等 canvasStore 完成水合（拿到 activeCanvasId），再 import queueStore
await sleep(30);
console.log(
  `[after-canvas-hydration] canvasStore._hasHydrated=${useCanvasStore.getState()._hasHydrated} ` +
    `activeCanvasId=${useCanvasStore.getState().activeCanvasId} flowStore.nodes.length=${useFlowStore.getState().nodes.length}`
);

const { useQueueStore } = await importRepo("stores/queueStore.ts");
await sleep(1600); // 恢复：waitForCanvasReady(≤600ms) + pump + 执行器返回

const job = useQueueStore.getState().jobs.find((j) => j.id === JOB_ID);
const canvasFlag = useCanvasStore.getState().canvases[0].nodes[0].data.queued;
const flowFlag = useFlowStore.getState().nodes.find((n) => n.id === NODE_ID)?.data?.queued;

console.log("");
console.log("=== 恢复之后（模拟 App.tsx setNodes 之前）===");
console.log(`job.status = ${job ? job.status : "(消失)"}   error = ${job?.error ?? "-"}`);
console.log(`canvasStore 里该节点的 data.queued = ${JSON.stringify(canvasFlag)}   ← 落盘的那一份`);
console.log(`flowStore   里该节点的 data.queued = ${JSON.stringify(flowFlag)}   ← 没水合时不存在`);

// 模拟 App.tsx:142-156：把活动画布的节点灌进 flowStore
const canvasNode = useCanvasStore.getState().canvases[0].nodes[0];
useFlowStore.setState({ nodes: [canvasNode], edges: [] });
const afterLoad = useFlowStore.getState().nodes.find((n) => n.id === NODE_ID)?.data?.queued;
const canRun = Boolean(canvasNode.data.prompt) && canvasNode.data.status !== "loading" && !(afterLoad === true);
console.log("");
console.log("=== 模拟 App.tsx setNodes（画布加载完成，用户看到节点）===");
console.log(`flowStore 节点 data.queued = ${JSON.stringify(afterLoad)}`);
console.log(`ImageGeneratorNode.canRun（简化） = ${canRun}`);
console.log("");
console.log(
  canRun
    ? "RESULT: 节点可用（REQ-001 已修复）"
    : "RESULT: 节点仍被锁死（显示排队中/按钮禁用）—— REQ-001 缺陷仍可复现"
);
