/**
 * 褰掑洜鎺㈤拡锛氬悓涓€涓?鎾ら攢澶嶆椿闄堟棫 queued:true 鈫?闃叉姈鍥炲啓 鈫?璺ㄩ噸鍚瓨娲?鐨勯攣锛? * 鍦ㄥ綋鍓嶅€欓€変笌 HEAD 鍩虹嚎涓婃槸鍚?*閮?*瀛樺湪锛堝垽鏂繖鏄湰杞柊寮曞叆杩樻槸鏃㈡湁缂洪櫡锛夈€? * R4_OVERLAY=<dir> 鏃讹紝@/stores/queueStore 涓?@/hooks/useImageGeneratorExecution
 * 浠庤鐩綍鍔犺浇锛堝唴鍚?git show HEAD: 鐨勫瓧鑺傜骇鍩虹嚎鏂囦欢锛夛紝鍏朵綑婧愮爜浠嶆潵鑷伐浣滃尯銆? * 鐢ㄦ硶锛?env:R4_OVERLAY="<dir>"; node --experimental-strip-types probe-r4-undo-attrib.mjs
 */
import { registerHooks, createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const require = createRequire(path.join("D:\\NextCreator", "package.json"));

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const OVERLAY = process.env.R4_OVERLAY || "";
const LABEL = OVERLAY ? "鍩虹嚎(HEAD)" : "鍊欓€?宸ヤ綔鍖?";

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.__NC_STORE_SEED__ = {};

const STUBS = {
  "@xyflow/react": `export const ReactFlow=()=>null;export const applyNodeChanges=(c,n)=>n;export const applyEdgeChanges=(c,e)=>e;
    export const addEdge=(e,es)=>es;export const MarkerType={};export const Position={};export const ConnectionLineType={};
    export const SelectionMode={};export const useStore=()=>({});export default {};`,
  "@tauri-apps/api/core": `export const invoke=async()=>{throw new Error("stub invoke");};export const Channel=class{};export const convertFileSrc=(p)=>p;export default {};`,
  "@tauri-apps/api/event": `export const listen=async()=>()=>{};export const emit=async()=>{};export default {};`,
  "@tauri-apps/plugin-store": `export class Store{static async load(){return new Store();}
    async get(k){return (globalThis.__NC_STORE_SEED__||{})[k] ?? null;}async set(){}async save(){}async delete(){}async keys(){return [];}}
    export const load=async()=>new Store();export default {load};`,
  "@tauri-apps/plugin-fs": `export const readFile=async()=>new Uint8Array();export const writeFile=async()=>{};export const exists=async()=>false;
    export const mkdir=async()=>{};export const remove=async()=>{};export const stat=async()=>({});export default {};`,
  "@tauri-apps/plugin-dialog": `export const open=async()=>null;export const save=async()=>null;export const message=async()=>{};export const ask=async()=>false;export const confirm=async()=>false;export default {};`,
  "@tauri-apps/plugin-opener": `export const openUrl=async()=>{};export const openPath=async()=>{};export const revealItemInDir=async()=>{};export default {};`,
};
function withTs(p) {
  if (existsSync(p) && path.extname(p)) return p;
  for (const cand of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(cand)) return cand;
  return p;
}
function resolveAt(spec) {
  const rel = spec.slice(2);
  if (OVERLAY) {
    const ov = withTs(path.join(OVERLAY, rel));
    if (existsSync(ov) && /\.(ts|tsx)$/.test(ov)) return ov;
  }
  return withTs(path.join(SRC, rel));
}
const FAITHFUL = `
export const executeImageGeneration = async (nodeId, options) => {
  const { useFlowStore } = await import("@/stores/flowStore");
  const node = useFlowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return { success: false, error: "鑺傜偣涓嶅瓨鍦? };
  await new Promise((r) => setTimeout(r, 10));
  if (options?.signal?.aborted) return { success: false, cancelled: true };
  useFlowStore.getState().updateNodeData(nodeId, { status: "loading", queued: false, error: undefined });
  await new Promise((r) => setTimeout(r, options?.dataOverride?.delayMs ?? 40));
  useFlowStore.getState().updateNodeData(nodeId, { status: "success", error: undefined });
  return { success: true, cancelled: false };
};
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);
`;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(resolveAt(spec)).href, shortCircuit: true };
    // overlay 鏂囦欢浣嶄簬浠撳簱涔嬪锛岃８鍖呭悕锛坺ustand/react/...锛夊繀椤绘樉寮忚В鏋愬埌浠撳簱鐨?node_modules
    if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("node:")) {
      try {
        return { url: pathToFileURL(require.resolve(spec)).href, shortCircuit: true };
      } catch {
        /* 钀藉埌 nextResolve */
      }
    }
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec") return { format: "module", source: FAITHFUL, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requireRepo2 = require;
const React = requireRepo2("react");
const { renderToStaticMarkup } = requireRepo2("react-dom/server");

const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const { useQueueStore } = await import(pathToFileURL(resolveAt("@/stores/queueStore")).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { useImageGeneratorExecution } = await import(pathToFileURL(resolveAt("@/hooks/useImageGeneratorExecution")).href);

const X = "gen-x";
const A = "canvas-a";
const mkNode = () => ({
  id: X, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" },
});
const PROBE_DATA = { ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" };
let handle = null;
function Probe() {
  const { handleGenerate } = useImageGeneratorExecution(X, PROBE_DATA);
  handle = handleGenerate;
  return null;
}
const marker = () => useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued;
const active = () => useQueueStore.getState().jobs.filter((j) => j.status === "queued" || j.status === "running");

useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mkNode()], edges: [] }], activeCanvasId: A, _hasHydrated: true });
useFlowStore.setState({ nodes: [mkNode()], edges: [], history: [], historyIndex: -1 });
useQueueStore.setState({ jobs: [], paused: false, concurrency: 1 });
renderToStaticMarkup(React.createElement(Probe));

console.log(`[${LABEL}] 鈶?鐐瑰嚮鐢熸垚锛氭爣璁?${JSON.stringify(marker())} 娲诲姩=${active().length}`);
useFlowStore.getState().saveToHistory();
const snapTrue = useFlowStore.getState().history.some((h) => (h.nodes || []).some((n) => n.id === X && n.data?.queued === true));
console.log(`  鈶?鎺掗槦绐楀彛鍐呬竴娆″彲鎾ら攢鎿嶄綔锛氬揩鐓у惈 queued:true=${snapTrue}`);
await sleep(400);
console.log(`  鈶?鏀跺熬鍚庯細鏍囪=${JSON.stringify(marker())} 娲诲姩=${active().length}`);
useFlowStore.getState().undo();
await sleep(20);
console.log(`  鈶?鎾ら攢鍚庯細鏍囪=${JSON.stringify(marker())} 娲诲姩=${active().length}`);
const { nodes, edges } = useFlowStore.getState();
useCanvasStore.getState().updateCanvasData(nodes, edges);
const persisted = useCanvasStore.getState().canvases.find((c) => c.id === A)?.nodes.find((n) => n.id === X)?.data?.queued;
const recoverable = useQueueStore.getState().jobs.filter((j) => j.status === "queued").length;
console.log(`  鈶?闃叉姈鍥炲啓鐢诲竷鍓湰锛歲ueued=${JSON.stringify(persisted)}锛涢槦鍒楀彲鎭㈠浠诲姟=${recoverable}`);
// 妯℃嫙閲嶅惎锛氱敾甯冨壇鏈浇鍥?flowStore锛圓pp.tsx:154锛?useFlowStore.setState({ nodes: useCanvasStore.getState().canvases.find((c) => c.id === A).nodes, edges: [] });
const d = useFlowStore.getState().nodes.find((n) => n.id === X)?.data;
const canRun = Boolean(d?.prompt) && d?.status !== "loading" && !(d?.queued === true);
console.log(`  鈶?閲嶅惎杞藉洖鍚庯細queued=${JSON.stringify(d?.queued)} canRun=${canRun}`);
console.log(`  RESULT[${LABEL}]: ${d?.queued === true && !canRun && recoverable === 0 ? "閿佹锛堟案涔呪€滄帓闃熶腑鈥濄€佹寜閽鐢ㄣ€佹仮澶嶉€昏緫涓嶅缃級" : "鏈攣姝?}`);

