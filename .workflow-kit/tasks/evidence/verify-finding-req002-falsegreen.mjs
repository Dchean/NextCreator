// 总控独立复现审查发现 1（用例 B 假绿）：拦截 imageGenerationExecution，模拟"executeImageGeneration 在首个 await 前即失败"
// 然后套用交付脚本的断言逻辑（counts.some(c => c > 1)），看缺陷完整存在时门禁给什么结论。
// 本文件只读交付物，不修改任何交付文件。
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve("D:/NextCreator");
const SRC = path.join(root, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

// 变异：让 executeImageGeneration 立刻返回失败（不进入任何 running 停留窗口）
const MUTANT_EXEC = `export const executeImageGeneration = async () => ({ success: false, error: "mutant: immediate failure" });
export const getImageBatchCount = () => 1;
export default {};`;

const STUBS = {
  "@/services/imageGenerationExecution": MUTANT_EXEC,
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

console.log("=== 独立复现审查发现 1：用例 B 假绿 ===");
console.log("变异条件：executeImageGeneration 在首个 await 前即返回失败（拦截 @/services/imageGenerationExecution）");
console.log("");

// 完全照搬交付脚本 scripts/queue-regression.mjs:248-271 的采样与判定
const activeCount = () =>
  useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running").length;

const counts = [];
for (let i = 1; i <= 3; i++) {
  await handle();
  counts.push(activeCount());
}
const totalJobs = useQueueStore.getState().jobs.length;
const sameNode = useQueueStore.getState().jobs.filter((j) => j.nodeId === "gen-1").length;

console.log("交付脚本的瞬时采样 counts =", counts.join("/"));
console.log("队列内 job 总数 totalJobs =", totalJobs);
console.log("同节点 job 数 =", sameNode);
console.log("");

const grew = counts.some((c) => c > 1);
const deliveredVerdict = grew ? "FAIL" : "PASS";
console.log("交付脚本判定（grew = counts.some(c=>c>1)）:", deliveredVerdict);
console.log("");
console.log("事实：同节点被重复入队", sameNode, "次 —— REQ-002 缺陷完整存在。");
if (deliveredVerdict === "PASS" && sameNode > 1) {
  console.log("");
  console.log("=> 假绿复现成功：缺陷存在（同节点 " + sameNode + " 个并发 job），但交付脚本判 PASS。");
  console.log("   与审查者报告一致：断言只看调用后的瞬时活动数，未看 job 总数/同节点数。");
} else {
  console.log("");
  console.log("=> 未能复现假绿（交付脚本判", deliveredVerdict, "）。");
}
