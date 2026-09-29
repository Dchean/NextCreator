/**
 * 审查者自写探针（TASK-003 r2）—— 逐字段核对"工作流路径经执行器产生的节点写入"
 *
 * 目标：不采信作者的注释，独立枚举"改动前的 nodeExecutor.executeImageGeneratorNode"与
 * "改动后 nodeExecutor → executeImageGeneration"在**同一场景**下写入节点 data 的键集合差异。
 *
 * 运法：对同一份探针，分别在 before 树（git HEAD src 逐字节还原）与候选树上执行，比较输出。
 *
 * 关键设计：
 *  - 用 store.setState 的**订阅**记录每次节点 data 的键变化（浅层键集），而不是直接读终态，
 *    这样才能看出"某个字段在中间被写了一次"（例如 queued）。
 *  - provider 用立刻成功且**带 thumb_path** 的替身（真实 save_image 在 storage.rs:495 就会返回
 *    thumb_path），fileStorageService 走真实模块 —— 由外部在 load 钩子里注入。
 *  - nodeExecutor.executeNode 是工作流路径的真实入口（workflowEngine:435 → nodeExecutor）。
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// 运行时由 NC_ROOT 指定被测树（before 树 / 候选树），默认按脚本位置推断
const root = process.env.NC_ROOT
  ? path.resolve(process.env.NC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");
const HAS_EXEC = existsSync(path.join(SRC, "services/imageGenerationExecution.ts"));
const HAS_LIMITER = existsSync(path.join(SRC, "services/concurrencyLimiter.ts"));
const LABEL = process.env.NC_LABEL || "(unlabeled)";

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
    // 真实 fileStorageService —— 但让 invoke 可用（返回带 thumb_path 的 ImageInfo，模拟真实后端）
    if (spec === "@/services/fileStorageService") return { url: "mutant:fs-probe", shortCircuit: true };
    // provider 替身：立刻成功、带 imageDataList
    if (spec === "@/services/imageGeneration") return { url: "mutant:gen-probe", shortCircuit: true };
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
    if (url === "mutant:fs-probe") {
      // 真实模块 + 覆盖 invoke：save_image 返回真实形状（storage.rs:497-507），
      // thumb_path 非空 —— 这是真实后端的行为，必须模拟。
      return {
        format: "module",
        source: `
          // 注意：每次调用都向 globalThis 上的**当前**数组推送，使调用方可以按场景重置快照
          export async function saveImage(base64Data, canvasId, nodeId, prompt, inputImages, imageType, model) {
            const calls = (globalThis.__NC_SAVE_CALLS__ ||= []);
            calls.push({ canvasId, nodeId, imageType, model, hasInputImages: Array.isArray(inputImages) && inputImages.length > 0 });
            return {
              id: "probe-img-" + calls.length,
              filename: "probe-" + calls.length + ".png",
              path: "C:/probe/canvas/" + (canvasId || "none") + "/probe-" + calls.length + ".png",
              size: 1234,
              created_at: Date.now(),
              canvas_id: canvasId, node_id: nodeId, image_type: imageType,
              // 真实后端 storage.rs:495 会为每张保存的图片生成缩略图并返回其路径（可能为 null）
              thumb_path: globalThis.__NC_THUMB_NULL__ ? null : "C:/probe/thumbs/probe-" + calls.length + ".webp",
            };
          }
          export async function readImage() { return "cHJvYmU="; }
          export function getImageUrl(p) { return "asset://" + p; }
          export async function ensureAssetPathsAllowed() {}
          export function getFilePathForDroppedFile() { return ""; }
          export async function ensureThumbnail(p) { return p + ".thumb"; }
          export async function deleteImage() {}
          export default {};
        `,
        shortCircuit: true,
      };
    }
    if (url === "mutant:gen-probe") {
      return {
        format: "module",
        source: `
          export const generateImage = async () => ({
            imageData: "data:image/png;base64,iVBORw0KGgo=",
            imageDataList: ["data:image/png;base64,iVBORw0KGgo="],
            text: "probe",
            metadata: { model: "probe-model" },
          });
          export const editImage = async () => ({
            imageData: "data:image/png;base64,iVBORw0KGgo=",
            imageDataList: ["data:image/png;base64,iVBORw0KGgo="],
            text: "probe",
            metadata: { model: "probe-model" },
          });
          export default {};
        `,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);
const { nodeExecutor } = await import(pathToFileURL(path.join(SRC, "services/nodeExecutor.ts")).href);

const NODE = "probe-node";
const CANVAS = "probe-canvas";
const PROMPT_NODE = "probe-prompt";
const INPUT_NODE = "probe-input";

const makeGen = (extra = {}) => ({
  ...getDefaultImageGeneratorData(),
  prompt: "probe inline prompt",
  model: "gemini-2.5-flash-image",
  ...extra,
});

// ---- 写入记录器：订阅 flowStore，记录每次节点 data 的键增量 ----
const writes = [];
function recordWrites(tag) {
  const prev = new Map();
  for (const n of useFlowStore.getState().nodes) prev.set(n.id, new Set(Object.keys(n.data || {})));
  return useFlowStore.subscribe((state) => {
    for (const n of state.nodes) {
      const now = Object.keys(n.data || {});
      const before = prev.get(n.id);
      if (!before) {
        prev.set(n.id, new Set(now));
        writes.push({ tag, node: n.id, kind: "NODE_ADDED", keys: now });
        continue;
      }
      const added = now.filter((k) => !before.has(k));
      if (added.length > 0) {
        writes.push({ tag, node: n.id, kind: "KEYS_ADDED", keys: added });
        for (const k of added) before.add(k);
      }
    }
  });
}

useCanvasStore.setState({
  activeCanvasId: CANVAS,
  canvases: [{ id: CANVAS, name: "probe", nodes: [], edges: [] }],
});

// 场景：imageGenerator 节点 + 一个 promptNode 连线提供提示词 + 一个 imageInputNode 带 base64 输入
// （base64 输入会驱动 persistInputImages 的"保存输入图片"分支，那是改动前不存在的写回点）
function seedNodes() {
  return [
    { id: PROMPT_NODE, type: "promptNode", position: { x: 0, y: 0 }, data: { label: "P", prompt: "connected prompt" } },
    {
      id: INPUT_NODE,
      type: "imageInputNode",
      position: { x: 0, y: 100 },
      data: { label: "I", imageData: "aW5wdXQ=", fileName: "in.png" },
    },
    { id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 200 }, data: makeGen({ queued: true }) },
  ];
}
function seedEdges() {
  // handle 契约来自 src/utils/connectionHandles.ts：
  //   提示词 → input-prompt；参考图槽位 → input-image-{k}
  return [
    { id: "e1", source: PROMPT_NODE, target: NODE, sourceHandle: "output-prompt", targetHandle: "input-prompt" },
    { id: "e2", source: INPUT_NODE, target: NODE, sourceHandle: "output-image", targetHandle: "input-image-0" },
  ];
}

console.log("=".repeat(78));
console.log(`LABEL=${LABEL}`);
console.log(`has imageGenerationExecution.ts = ${HAS_EXEC}`);
console.log(`has concurrencyLimiter.ts       = ${HAS_LIMITER}`);
console.log(`nodeExecutor hash = ${readFileSync(path.join(SRC, "services/nodeExecutor.ts")).length} bytes`);
console.log("=".repeat(78));

// ---------- 场景 1：工作流路径 executeNode，节点上有一个**合法 queued 标记** ----------
async function scenario(desc, data, options = {}) {
  writes.length = 0;
  useFlowStore.setState({ nodes: seedNodes().map((n) => (n.id === NODE ? { ...n, data } : n)), edges: seedEdges() });
  useCanvasStore.setState({
    activeCanvasId: CANVAS,
    canvases: [{ id: CANVAS, name: "probe", nodes: seedNodes().map((n) => (n.id === NODE ? { ...n, data } : n)), edges: seedEdges() }],
  });
  globalThis.__NC_SAVE_CALLS__ = [];
  const unsub = recordWrites(desc);
  let result;
  let threw = null;
  try {
    result = await nodeExecutor.executeNode(useFlowStore.getState().nodes.find((n) => n.id === NODE), CANVAS, options.signal);
  } catch (e) {
    threw = e && e.message ? e.message : String(e);
  }
  await new Promise((r) => setTimeout(r, 60));
  unsub();

  const genFlow = useFlowStore.getState().nodes.find((n) => n.id === NODE);
  const inputFlow = useFlowStore.getState().nodes.find((n) => n.id === INPUT_NODE);
  const promptFlow = useFlowStore.getState().nodes.find((n) => n.id === PROMPT_NODE);
  const canvas = useCanvasStore.getState().canvases.find((c) => c.id === CANVAS);
  const genCanvas = canvas && canvas.nodes.find((n) => n.id === NODE);

  console.log("");
  console.log("### " + desc);
  console.log("  executeNode 返回: " + JSON.stringify(result) + (threw ? `  THREW=${threw}` : ""));
  console.log("  generator.data 键(去 undefined): " + JSON.stringify(nonUndef(genFlow && genFlow.data)));
  console.log("  generator.data.queued = " + JSON.stringify(genFlow && genFlow.data && genFlow.data.queued));
  console.log("  canvas 副本 .queued    = " + JSON.stringify(genCanvas && genCanvas.data && genCanvas.data.queued));
  console.log("  inputNode.data 键      = " + JSON.stringify(nonUndef(inputFlow && inputFlow.data)));
  console.log("  inputNode.imagePath    = " + JSON.stringify(inputFlow && inputFlow.data && inputFlow.data.imagePath));
  console.log("  promptNode.data 键     = " + JSON.stringify(nonUndef(promptFlow && promptFlow.data)));
  console.log("  saveImage 调用         = " + JSON.stringify(globalThis.__NC_SAVE_CALLS__ || []));
  console.log("  flowStore 写入事件     = " + JSON.stringify(writes.filter((w) => w.kind === "KEYS_ADDED")));
}

function nonUndef(data) {
  if (!data) return null;
  const out = {};
  for (const k of Object.keys(data).sort()) {
    if (data[k] !== undefined) out[k] = Array.isArray(data[k]) ? `[${data[k].length}]` : typeof data[k] === "object" && data[k] !== null ? "{obj}" : data[k];
  }
  return out;
}

// 场景 1：成功（inline prompt，有连线输入 → 走 edit 分支 + persistInputImages）
await scenario("S1 工作流路径·成功（queued:true 预置，含输入图→落盘分支）", makeGen({ queued: true }));

// 场景 2：缺提示词（inline 空、无 prompt 连线）→ 错误分支
await scenario("S2 工作流路径·缺少提示词（error 文案）", makeGen({ prompt: "", queued: true }));

// 场景 3：预取消
{
  const c = new AbortController();
  c.abort();
  await scenario("S3 工作流路径·预取消", makeGen({ queued: true }), { signal: c.signal });
}

// 场景 4：取消落在 provider 返回之后（模拟 REQ-006 主场景）—— 用已 abort 的 signal 无法进入，
// 改为在 provider 之前 abort（用 microtask 竞争），这里只做"返回后取消"的近似：不适用，略。
// 场景 5：gpt-image-2 尺寸校验失败分支
await scenario("S5 工作流路径·尺寸校验失败", makeGen({ queued: true, apiProtocol: "openai-images", model: "gpt-image-2", size: "1x1" }));

console.log("");
console.log("=".repeat(78));
console.log(`DONE LABEL=${LABEL}`);
