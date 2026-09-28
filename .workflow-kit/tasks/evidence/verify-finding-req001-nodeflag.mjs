// 总控独立复现审查发现 2：用例 A 未覆盖 REQ-001 验收第二句（"相关节点不再永久显示排队中"）
// 变异：模拟"job 被标为 error，但 node.data.queued 仍留在 true"（审查者称此路径真实可达）
// 然后套用交付脚本用例 A 的断言逻辑，看它给什么结论。
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve("D:/NextCreator");
const SRC = path.join(root, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const SEED = {
  "generation-queue": JSON.stringify({
    state: {
      jobs: [{
        id: "regression-stale-queued-1", nodeId: "regression-node-1", canvasId: null,
        nodeLabel: "回归用例A", modelLabel: "regression-model",
        promptPreview: "persisted queued job before restart", status: "queued", createdAt: Date.now(),
      }],
      concurrency: 2,
    },
    version: 0,
  }),
};
globalThis.__NC_STORE_SEED__ = SEED;

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
      async get(k){ const s=globalThis.__NC_STORE_SEED__||{}; return s[k] ?? null; }
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

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);
const JOB_ID = "regression-stale-queued-1";

const waitFor = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
};

await waitFor(() => useQueueStore.persist.hasHydrated(), 3000);
const seeded = useQueueStore.getState().jobs.find((j) => j.id === JOB_ID);
console.log("=== 独立复现审查发现 2：用例 A 不检查节点可见标记 ===");
console.log("水合后种子 job 存在:", !!seeded, "| status =", seeded?.status);

// —— 关键：模拟"job 已被处置（非 queued），但节点上的 queued 标记仍残留 true" ——
// 这是审查者声称真实可达的路径：queueStore 水合回调只改 job 状态，从不清 node.data.queued
const nodeDataQueued = true;   // 残留标记（模拟重启后 App.tsx setNodes 恢复出来的节点数据）
useQueueStore.setState((s) => ({
  jobs: s.jobs.map((j) => j.id === JOB_ID ? { ...j, status: "error", error: "应用重启导致中断，可重试" } : j),
}));

const finalJob = useQueueStore.getState().jobs.find((j) => j.id === JOB_ID);
console.log("处置后 job status =", finalJob?.status);

// 交付脚本用例 A 的全部判定逻辑（照搬 :181-192）
const released = await waitFor(() => {
  const j = useQueueStore.getState().jobs.find((x) => x.id === JOB_ID);
  return !j || j.status !== "queued";
}, 1500);
const deliveredVerdict = released ? "PASS" : "FAIL";

console.log("");
console.log("交付脚本用例 A 判定:", deliveredVerdict);
console.log("");
console.log("但此时用户可见状态为：节点 data.queued =", nodeDataQueued,
            "→ ImageGeneratorNode.tsx:215 的 canRun 为 false，按钮禁用并显示“排队中”");
console.log("交付脚本从未读取该标记（它只查 job.status，且未为种子 job 建任何 flowStore 节点）。");
console.log("");
if (deliveredVerdict === "PASS" && nodeDataQueued === true) {
  console.log("=> 发现 2 复现成功：job 已被处置，但节点仍显示“排队中”，门禁却给 PASS。");
  console.log("   REQ-001 验收第二句（相关节点不再永久显示排队中）未被覆盖。");
} else {
  console.log("=> 未能复现发现 2。");
}
