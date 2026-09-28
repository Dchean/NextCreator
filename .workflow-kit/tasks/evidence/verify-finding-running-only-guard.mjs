// 总控独立验证第三轮审查发现 1 的机制核心：
// 门禁的用例 B/C 都只操作单个节点 → 首点后 pump() 同步把该 job 置为 running
// → 于是"仅 running 守卫"与"queued||running 守卫"在门禁场景下行为无法区分。
// 本脚本证明：quota 被别的节点占满时，同一节点可累积多个 queued（仅 running 守卫放行）。
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

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);

console.log("=== 机制验证：pump() 是否同步把首个 job 置为 running ===");
useQueueStore.setState({ jobs: [], paused: false, concurrency: 2 });
const id = useQueueStore.getState().enqueue({ nodeId: "nA", canvasId: null, nodeLabel: "A", modelLabel: "m", promptPreview: "p" });
const st = useQueueStore.getState().jobs.find((j) => j.id === id)?.status;
console.log("enqueue 后同一次同步调用内该 job 状态 =", st);
console.log("→ 门禁用例 B/C 只操作单节点，首点后该节点必然已有 running job");
console.log("→ 因此『仅 running 守卫』与『queued||running 守卫』在门禁场景下无法区分");
console.log("");

console.log("=== 危害验证：并发额度被占满时，同一节点可累积多个 queued ===");
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
// 节点 Z 先占满唯一额度
useQueueStore.getState().enqueue({ nodeId: "nZ", canvasId: null, nodeLabel: "Z", modelLabel: "m", promptPreview: "z" });
const z = useQueueStore.getState().jobs.find((j) => j.nodeId === "nZ");
console.log("节点 Z 状态 =", z?.status, "（占满 concurrency=1）");

// 模拟"仅 running 守卫"：该节点无 running 时放行
const runningOnlyGuard = (nodeId) =>
  useQueueStore.getState().jobs.some((j) => j.nodeId === nodeId && j.status === "running");

const clickTimes = 2;
for (let i = 0; i < clickTimes; i++) {
  if (!runningOnlyGuard("nB")) {
    useQueueStore.getState().enqueue({ nodeId: "nB", canvasId: null, nodeLabel: "B", modelLabel: "m", promptPreview: "b" });
  }
}
const bJobs = useQueueStore.getState().jobs.filter((j) => j.nodeId === "nB");
console.log(`『仅 running 守卫』下点击节点 B ${clickTimes} 次 → 节点 B 的 job 数 =`, bJobs.length,
            "| 状态 =", bJobs.map((j) => j.status).join(","));
console.log("");
if (bJobs.length > 1) {
  console.log("=> 危害复现：同一节点累积了", bJobs.length, "个 job。");
  console.log("   节点 Z 结束释放额度后 pump() 会同时派发它们 → 并发写同一 node.data（REQ-002 要防的危害）。");
  console.log("   而门禁的用例 B/C 结构上无法暴露此形态（它们只操作单节点）。");
} else {
  console.log("=> 未复现。");
}
