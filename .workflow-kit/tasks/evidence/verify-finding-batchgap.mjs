// 总控独立验证审查者的"批量缺口"发现：
// 用例 B 是否真的让 getImageBatchCount 恒为 1，从而完全不执行 useImageGeneratorExecution.ts:61-74 的批量分支。
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve("D:/NextCreator");
const SRC = path.join(root, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

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
globalThis.__NC_STORE_SEED__ = {};

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

const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useImageGeneratorExecution } = await import(pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const { getImageBatchCount } = await import(pathToFileURL(path.join(SRC, "services/imageGenerationExecution.ts")).href);

console.log("=== 独立验证：用例 B 是否执行了批量分支 ===");
const def = { ...getDefaultImageGeneratorData(), prompt: "hello" };
console.log("用例 B 使用的节点数据：apiProtocol =", def.apiProtocol, "| n =", def.n, "| batchCount =", getImageBatchCount(def));
console.log("");

// 与交付门禁用例 B 完全一致地驱动真实 hook（n 默认 = 1）
useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
useFlowStore.setState({
  nodes: [{ id: "gen-1", type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: def }],
  edges: [],
});
let h1 = null;
function P1() { h1 = useImageGeneratorExecution("gen-1", useFlowStore.getState().nodes[0].data).handleGenerate; return null; }
renderToStaticMarkup(React.createElement(P1));
for (let i = 0; i < 3; i++) await h1();
const n1 = useQueueStore.getState().jobs.filter((j) => j.nodeId === "gen-1").length;
console.log("n=1 时 3 次点击 → 同节点 job 数 =", n1, "（走单图 else 分支，每次 1 个 job）");
console.log("  → 批量分支（useImageGeneratorExecution.ts:61-74）是否被执行：否");
console.log("");

// 对照：n=4 时同一份代码的行为（证明批量分支真实存在且可被触发）
useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
const batchData = { ...getDefaultImageGeneratorData(), prompt: "hello", n: 4 };
console.log("对照：把 n 改为 4 → batchCount =", getImageBatchCount(batchData));
useFlowStore.setState({
  nodes: [{ id: "gen-1", type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: batchData }],
  edges: [],
});
let h2 = null;
function P2() { h2 = useImageGeneratorExecution("gen-1", useFlowStore.getState().nodes[0].data).handleGenerate; return null; }
renderToStaticMarkup(React.createElement(P2));
for (let i = 0; i < 3; i++) await h2();
const n4 = useQueueStore.getState().jobs.filter((j) => j.nodeId === "gen-1").length;
console.log("n=4 时 3 次点击 → 同节点 job 数 =", n4);
console.log("");
if (n1 === 3 && n4 > 3) {
  console.log("=> 审查者发现复现成功：交付门禁只用 n=1，批量分支从未被覆盖；");
  console.log("   而 n=4 时同一份未修复代码让同节点 job 数达", n4, "，正是 REQ-002 要防的并发覆盖危害。");
} else {
  console.log("=> 未能复现（n1 =", n1, ", n4 =", n4, "）");
}
