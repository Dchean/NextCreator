// 临时验证脚本（总控探针 2）：验证调研子代理的「发现 A」——onRehydrateStorage 的 running 恢复分支是否死代码
// 并核对 partialize 过滤与 persist API 的可用性
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve("D:/NextCreator");
const SRC = path.join(root, "src");

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
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

const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);

// —— 发现 A 验证：partialize 是否可能输出 running ——
const opts = useQueueStore.persist.getOptions();
console.log("persist name:", opts.name);

const allStatuses = ["queued", "running", "success", "error", "cancelled"];
const fakeJobs = allStatuses.map((s, i) => ({
  id: "j" + i, nodeId: "n", canvasId: null, nodeLabel: "l", modelLabel: "m",
  promptPreview: "p", status: s, createdAt: 0,
}));
const partial = opts.partialize({ jobs: fakeJobs, concurrency: 2, paused: false, isQueuePanelOpen: false });
const outStatuses = partial.jobs.map((j) => j.status);
console.log("partialize output statuses:", outStatuses.join(","));
console.log("partialize CAN output running:", outStatuses.includes("running"));
console.log("=> onRehydrateStorage 的 running 恢复分支是否可能命中:", outStatuses.includes("running"));

// —— 发现 B 验证：persist API 可用性 ——
console.log("persist.rehydrate is function:", typeof useQueueStore.persist.rehydrate === "function");
console.log("persist.hasHydrated is function:", typeof useQueueStore.persist.hasHydrated === "function");
console.log("hasHydrated now:", useQueueStore.persist.hasHydrated());

// —— 反证：若 partialize 不过滤 running，恢复分支是否会命中（证明分支逻辑本身有效）——
const filteredOut = { jobs: fakeJobs, concurrency: 2, paused: false, isQueuePanelOpen: false };
const interrupted = filteredOut.jobs.filter((j) => j.status === "running");
console.log("若不过滤, 恢复分支能捕获的 running 数:", interrupted.length, "(证明分支逻辑有效, 只是输入恒空)");

// —— 关键对照：REQ-001 的 queued 场景在恢复分支覆盖范围内吗 ——
console.log("queued 是否被恢复分支处理:", "running" === "queued" ? "是" : "否 <- 这就是 REQ-001 根因");
