// 总控独立验证第五轮审查的「暂停态假绿」发现：
// 若 store 层守卫把活动判定写成 `!paused && sameNode.some(queued||running)`（一个可信的误判），
// 暂停态下同一节点重叠点击是否会累积并发 job —— 即"六用例全 PASS 而缺陷仍在"。
// 本脚本不修改任何交付物，只驱动真实 store 与真实 hook。
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
      async get(){return null;}async set(){}async save(){}async delete(){}async keys(){return [];}}
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

const NODE = "gen-paused";
const nodeJobs = () => useQueueStore.getState().jobs.filter((j) => j.nodeId === NODE).length;

// 一个"可信的误判"守卫：队列已暂停，就认为不可能有任务在跑
const buggyGuard = () => {
  const s = useQueueStore.getState();
  return !s.paused && s.jobs.some((j) => j.nodeId === NODE && (j.status === "queued" || j.status === "running"));
};

async function run(paused) {
  useQueueStore.setState({ jobs: [], paused, concurrency: 2 });
  useFlowStore.setState({
    nodes: [{ id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 },
              data: { ...getDefaultImageGeneratorData(), prompt: "hi" } }],
    edges: [],
  });
  let handle = null;
  function Probe() {
    const st = useFlowStore.getState();
    handle = useImageGeneratorExecution(NODE, st.nodes[0].data).handleGenerate;
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));

  // 三次重叠点击，并在守卫处模拟"仅当未暂停才判定"的误判
  const clicks = [];
  for (let i = 0; i < 3; i++) {
    if (buggyGuard()) continue;            // 误判：暂停时守卫直接放行
    clicks.push(handle());                 // 注意：不 await，制造重叠窗口
  }
  await Promise.allSettled(clicks);
  return { paused, jobs: nodeJobs() };
}

console.log("=== 独立验证：暂停态假绿 ===");
console.log("守卫形态：!paused && 同节点有 queued||running  →  拒绝入队（即暂停时不判定）");
console.log("");
for (const p of [false, true]) {
  const r = await run(p);
  console.log(`paused=${String(r.paused).padEnd(5)} → 同节点 job 数 = ${r.jobs}`);
}
console.log("");
const off = await run(false);
const on = await run(true);
console.log("非暂停时:", off.jobs, "个 job；暂停时:", on.jobs, "个 job");
console.log("");
if (on.jobs > 1 && off.jobs > 1) {
  console.log("=> 两种状态都产生并发 job（本探针未实现正确守卫，仅演示暂停态更严重）。");
} else if (on.jobs > 1) {
  console.log("=> 暂停态缺陷复现：暂停时同一节点累积了", on.jobs, "个并发 job，非暂停时为", off.jobs, "个。");
}
console.log("");
console.log("可达性（已核对源码）：");
console.log("  QueuePanel.tsx:110-115  有真实的「暂停队列」按钮（togglePaused）");
console.log("  ImageGeneratorNode.tsx:215  canRun 只看 status/isQueued/prompt/尺寸，不看 paused → 暂停时仍可点生成");
console.log("  useImageGeneratorExecution.ts:86-90  data.queued 在首个 await 之后才写 → 暂停态连点正好落在这个窗口");
