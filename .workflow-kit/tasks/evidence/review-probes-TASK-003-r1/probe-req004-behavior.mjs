/**
 * 审查者探针 P-req004-behavior（TASK-003 r1 独立审查用；只读，不修改任何产品代码）
 *
 * 目的：REQ-004 要求"统一执行链但保持工作流路径的既有可观察行为"。本探针不看任何注释，
 * 而是**同一份场景矩阵在两个源码版本上各跑一次**，把可观察结果规范化后输出 JSON：
 *   · candidate = 工作区当前源码（候选快照）
 *   · before    = HEAD 上的改动前源码（用 git show HEAD:<path> 还原到另一份副本）
 * 两者都用同一份 loader / 同一套 stub / 同一份场景矩阵，因此差异只可能来自被测源码。
 *
 * 驱动层次是 **nodeExecutor.executeNode**（本次改动的那一层），并记录：
 *   · NodeExecutionResult（success / error / cancelled）
 *   · 节点 data 的对外字段（status/error/errorDetails/outputImage/outputImagePath/
 *     outputImages/outputImagePaths/outputThumbPath/outputThumbPaths/runRecords/queued）
 *
 * 用法：node --experimental-strip-types <this> <output.json>
 *       （cwd 必须指向要测的那份源码根）
 */
import { registerHooks } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const OUT = process.argv[2] || "probe-req004-behavior.json";
const root = process.cwd();
const SRC = path.join(root, "src");

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

const imageGenUrl = "mutant:probe-imagegen";
const fsUrl = "mutant:probe-fs";

registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGeneration") return { url: imageGenUrl, shortCircuit: true };
    if (spec === "@/services/fileStorageService") return { url: fsUrl, shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === imageGenUrl) {
      const real = JSON.stringify(pathToFileURL(path.join(SRC, "services/imageGeneration/index.ts")).href);
      return {
        format: "module", shortCircuit: true,
        source: `
          import { generateImage as realGenerateImage, editImage as realEditImage } from ${real};
          export * from ${real};
          const cfg = () => globalThis.__P__ || {};
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          async function call(fn, args) {
            const c = cfg();
            if (c.delayMs) await sleep(c.delayMs);
            if (c.behaviour === "throw") throw new Error("probe: provider failure");
            if (c.behaviour === "error") return { error: "probe: provider error", errorDetails: { code: "E-PROBE" } };
            if (c.behaviour === "empty") return { text: "probe: no image" };
            return { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="], text: "probe ok" };
          }
          export const generateImage = async (...args) => call(realGenerateImage, args);
          export const editImage = async (...args) => call(realEditImage, args);
        `,
      };
    }
    if (url === fsUrl) {
      const real = JSON.stringify(pathToFileURL(path.join(SRC, "services/fileStorageService.ts")).href);
      return {
        format: "module", shortCircuit: true,
        source: `
          import { saveImage as realSaveImage } from ${real};
          export * from ${real};
          export async function saveImage(...args) {
            const gate = globalThis.__SAVE_GATE__;
            if (!gate) return realSaveImage(...args);
            gate.markEntered();
            await gate.wait;
            return realSaveImage(...args);
          }
        `,
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

const CANVAS = "probe-canvas";
const NODE = "probe-node";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot() {
  const n = useFlowStore.getState().nodes.find((x) => x.id === NODE);
  const d = (n && n.data) || {};
  return {
    status: d.status ?? null,
    error: d.error ?? null,
    errorDetails: d.errorDetails ?? null,
    outputImage: d.outputImage ?? null,
    outputImagePath: d.outputImagePath ?? null,
    outputImages: d.outputImages ?? null,
    outputImagePaths: d.outputImagePaths ?? null,
    outputThumbPath: d.outputThumbPath ?? null,
    outputThumbPaths: d.outputThumbPaths ?? null,
    runRecords: (d.runRecords || []).map((r) => ({ status: r.status, error: r.error ?? null, hasOutput: Boolean(r.output) })),
    queued: d.queued ?? null,
  };
}

function seed({ prompt, withCanvas }) {
  const data = { ...getDefaultImageGeneratorData(), prompt, model: "gemini-2.5-flash-image" };
  const node = { id: NODE, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data };
  useFlowStore.setState({ nodes: [node], edges: [] });
  useCanvasStore.setState({
    activeCanvasId: withCanvas ? CANVAS : null,
    canvases: withCanvas ? [{ id: CANVAS, name: "probe", nodes: [JSON.parse(JSON.stringify(node))], edges: [] }] : [],
  });
  return node;
}

const results = {};

async function scenario(name, opts) {
  const { prompt = "probe prompt", withCanvas = false, behaviour = "ok", delayMs = 0, abortAfterMs = null, cancelDuringSave = false } = opts;
  globalThis.__P__ = { behaviour, delayMs };
  let controller = new AbortController();
  let resolveEntered; const entered = new Promise((r) => (resolveEntered = r));
  let releaseSave; const saveMayProceed = new Promise((r) => (releaseSave = r));
  if (cancelDuringSave) {
    globalThis.__SAVE_GATE__ = { markEntered: () => resolveEntered(), wait: saveMayProceed };
  }
  try {
    const node = seed({ prompt, withCanvas });
    let result, thrown = null;
    const p = nodeExecutor
      .executeNode(node, withCanvas ? CANVAS : null, controller.signal)
      .then((r) => { result = r; })
      .catch((e) => { thrown = e && e.message ? e.message : String(e); });
    if (abortAfterMs !== null) {
      await sleep(abortAfterMs);
      controller.abort();
    }
    if (cancelDuringSave) {
      const opened = await Promise.race([entered.then(() => true), sleep(5000).then(() => false)]);
      if (opened) { controller.abort(); }
      releaseSave();
      results[name + "__saveWindowOpened"] = opened;
    }
    await p;
    results[name] = { result, thrown, node: snapshot() };
  } catch (e) {
    results[name] = { harnessError: e && e.message ? e.message : String(e) };
  } finally {
    delete globalThis.__SAVE_GATE__;
    delete globalThis.__P__;
  }
}

await scenario("S1_success_no_canvas", { withCanvas: false });
await scenario("S2_success_with_canvas_saveimage_fails", { withCanvas: true });
await scenario("S3_empty_prompt", { prompt: "" });
await scenario("S4_provider_error", { behaviour: "error" });
await scenario("S5_provider_no_image", { behaviour: "empty" });
await scenario("S6_provider_throws", { behaviour: "throw" });
await scenario("S7_preaborted_signal", { abortAfterMs: 0, delayMs: 200 });
await scenario("S8_cancel_during_request", { delayMs: 400, abortAfterMs: 120 });
await scenario("S9_cancel_during_save", { withCanvas: true, delayMs: 0, cancelDuringSave: true });

writeFileSync(OUT, JSON.stringify({ root, results }, null, 2), "utf8");
console.log(`wrote ${OUT} (root=${root})`);
console.log(Object.entries(results).map(([k, v]) => `${k}: ${v && v.result ? `success=${v.result.success} error=${JSON.stringify(v.result.error ?? null)} node.status=${JSON.stringify(v.node.status)}` : JSON.stringify(v)}`).join("\n"));
