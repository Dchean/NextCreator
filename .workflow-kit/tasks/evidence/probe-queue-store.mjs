// 临时验证脚本（总控探针，非交付物）
// 目的：独立复现调研子代理关于「Node 24 --experimental-strip-types + registerHooks 可驱动 queueStore」的结论
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve("D:/NextCreator");
const SRC = path.join(root, "src");

// 1) window stub（tauriStorage.ts:100 顶层 window.addEventListener）
const listeners = [];
globalThis.window = {
  addEventListener: (...a) => listeners.push(a),
  removeEventListener: () => {},
  localStorage: undefined,
};
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

// 2) @xyflow/react stub —— 必须在此层 stub，react-dom 的 CJS require 拦不住
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
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}async get(){return null;}async set(){}async save(){}async delete(){}async keys(){return [];}}
    export const load=async()=>new Store();export default {load};`,
  "@tauri-apps/plugin-fs": `export const readFile=async()=>new Uint8Array();export const writeFile=async()=>{};
    export const exists=async()=>false;export const mkdir=async()=>{};export const remove=async()=>{};export const stat=async()=>({});export default {};`,
  "@tauri-apps/plugin-dialog": `export const open=async()=>null;export const save=async()=>null;export const message=async()=>{};export const ask=async()=>false;export const confirm=async()=>false;export default {};`,
  "@tauri-apps/plugin-opener": `export const openUrl=async()=>{};export const openPath=async()=>{};export const revealItemInDir=async()=>{};export default {};`,
};

function resolveAlias(spec) {
  if (spec.startsWith("@/")) return path.join(SRC, spec.slice(2));
  return null;
}

function withTsExtension(p) {
  if (existsSync(p) && path.extname(p)) return p;
  for (const cand of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) {
    if (existsSync(cand)) return cand;
  }
  return p;
}

registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) {
      return { url: "stub:" + spec, shortCircuit: true };
    }
    const aliased = resolveAlias(spec);
    if (aliased) {
      const target = withTsExtension(aliased);
      return { url: pathToFileURL(target).href, shortCircuit: true };
    }
    // 无扩展名的相对导入
    if (spec.startsWith(".") && !path.extname(spec)) {
      const base = context.parentURL ? fileURLToPath(new URL(spec, context.parentURL)) : spec;
      const target = withTsExtension(base);
      if (existsSync(target)) return { url: pathToFileURL(target).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) {
      const spec = url.slice(5);
      return { format: "module", source: STUBS[spec], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);

console.log("IMPORT OK");
console.log("initial ->", JSON.stringify({
  jobs: useQueueStore.getState().jobs.length,
  concurrency: useQueueStore.getState().concurrency,
  paused: useQueueStore.getState().paused,
}));

// 探针 1：enqueue 后是否进入 running（证明 pump 真实运行）
const id = useQueueStore.getState().enqueue({
  nodeId: "probe-node", canvasId: null, nodeLabel: "probe", modelLabel: "probe", promptPreview: "p",
});
console.log("enqueue ->", useQueueStore.getState().jobs.find((j) => j.id === id)?.status);

await new Promise((r) => setTimeout(r, 250));
const job = useQueueStore.getState().jobs.find((j) => j.id === id);
console.log("after pump ->", job?.status, "|", job?.error);

// 探针 2：concurrency 钳制
useQueueStore.getState().setConcurrency(1);
console.log("clamp(1) ->", useQueueStore.getState().concurrency);
useQueueStore.getState().setConcurrency(99);
console.log("clamp(99) ->", useQueueStore.getState().concurrency);

// 探针 3（关键）：模拟"重启后有遗留 queued"——pump 未在启动时调用是否导致永久卡住
useQueueStore.setState({
  jobs: [
    { id: "stale-1", nodeId: "n1", canvasId: null, nodeLabel: "l", modelLabel: "m", promptPreview: "p",
      status: "queued", createdAt: Date.now() },
  ],
});
console.log("simulated restart -> stale job status:", useQueueStore.getState().jobs[0].status);
await new Promise((r) => setTimeout(r, 250));
console.log("after 250ms WITHOUT explicit pump -> stale job status:",
  useQueueStore.getState().jobs[0].status, "(若仍为 queued 即复现 REQ-001)");

// 反证：显式调用 pump 后是否恢复
useQueueStore.getState().pump();
await new Promise((r) => setTimeout(r, 250));
console.log("after EXPLICIT pump -> stale job status:", useQueueStore.getState().jobs[0].status);
