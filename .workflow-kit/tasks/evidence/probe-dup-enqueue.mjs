// 总控基线探针：用真实 React hook 证明 REQ-002（缺少同节点重复入队保护）的红状态
// 技术来源：编码子代理 #2 的 spike（scripts/.spike-hook.mjs）已验证 renderToStaticMarkup 可驱动真实 useImageGeneratorExecution
// 本文件是基线证据，不属于交付物；交付用的 scripts/queue-regression.mjs 由编码子代理编写
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
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}async get(){return null;}async set(){}async save(){}async delete(){}async keys(){return [];}}
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

const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useImageGeneratorExecution } = await import(pathToFileURL(path.join(SRC, "hooks/useImageGeneratorExecution.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);

useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
useFlowStore.setState({
  nodes: [{ id: "gen-1", type: "imageGeneratorNode", position: { x: 0, y: 0 },
            data: { ...getDefaultImageGeneratorData(), prompt: "hello" } }],
  edges: [],
});

let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution("gen-1", useFlowStore.getState().nodes[0].data);
  handle = handleGenerate;
  return null;
}
renderToStaticMarkup(React.createElement(Probe));

const active = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");
const snapshot = (label) => {
  const a = active();
  console.log(`${label}: 活动 job 数=${a.length} | 状态=[${a.map((j) => j.status).join(",")}]`);
  return a.length;
};

console.log("=== REQ-002 红状态验证：同一节点连续触发生成 ===");
await handle();
const after1 = snapshot("第 1 次 handleGenerate");

await handle();
const after2 = snapshot("第 2 次 handleGenerate（连点）");

await handle();
const after3 = snapshot("第 3 次 handleGenerate（连点）");

console.log("");
console.log("结论：");
console.log("  第 1 次后活动 job =", after1, "（预期 1）");
console.log("  第 2 次后活动 job =", after2, after2 > 1 ? `← 红：产生了 ${after2 - 1} 个重复 job` : "（已有保护）");
console.log("  第 3 次后活动 job =", after3, after3 > 1 ? `← 红：产生了 ${after3 - 1} 个重复 job` : "（已有保护）");
console.log("");
if (after3 > 1) {
  console.log("REQ-002 RED CONFIRMED: 同节点重复入队未受保护，连点会创建并发任务写同一 node.data");
  process.exitCode = 1;
} else {
  console.log("REQ-002 未复现：重复入队已被保护");
}
