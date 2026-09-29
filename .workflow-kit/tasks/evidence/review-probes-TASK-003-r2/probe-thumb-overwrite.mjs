/**
 * 审查者自写探针（TASK-003 r2）—— 缩略图字段的"覆写"边界
 *
 * 场景：节点上**已有一个** outputThumbPath（例如用户先前手动生成一次留下的缩略图）。
 * 此后对该节点跑**工作流路径**，而本次落盘后端未返回 thumb_path（storage.rs:495 的
 * generate_thumbnail_file 失败即返回 None，属真实可能）。
 *
 * 问题：改动前的 nodeExecutor 从不写 outputThumbPath，因此旧值会被**原样保留**；
 * 复用后的执行器在成功写回时**无条件**写 outputThumbPath（值为 undefined）→ 旧值被抹掉。
 * 本探针在两棵树上跑同一场景，直接对比该字段的终态。
 *
 * 运行：NC_ROOT=<树> NC_LABEL=<标签> node --experimental-strip-types probe-thumb-overwrite.mjs
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = process.env.NC_ROOT ? path.resolve(process.env.NC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");
const LABEL = process.env.NC_LABEL || "(unlabeled)";
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.__NC_STORE_SEED__ = {};
globalThis.__NC_THUMB_NULL__ = true;   // 本次落盘不返回 thumb_path

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
  for (const c of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(c)) return c;
  return p;
}
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGeneration") return { url: "mutant:gen", shortCircuit: true };
    if (spec === "@/services/fileStorageService") return { url: "mutant:fs", shortCircuit: true };
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
    if (url === "mutant:gen") {
      return { format: "module", shortCircuit: true, source: `
        const fake = { imageData: "data:image/png;base64,iVBORw0KGgo=", imageDataList: ["data:image/png;base64,iVBORw0KGgo="], text: "t" };
        export const generateImage = async () => fake; export const editImage = generateImage; export default {};` };
    }
    if (url === "mutant:fs") {
      return { format: "module", shortCircuit: true, source: `
        export async function saveImage(base64Data, canvasId, nodeId, prompt, inputImages, imageType, model) {
          return {
            id: "i", filename: "f.png",
            path: "C:/probe/images/" + (nodeId || "x") + "-" + imageType + ".png",
            size: 1, created_at: Date.now(), canvas_id: canvasId, node_id: nodeId, image_type: imageType,
            // 后端未生成缩略图（storage.rs:495 的失败分支 → None）
            thumb_path: null,
          };
        }
        export async function readImage() { return "cHJvYmU="; }
        export function getImageUrl(p) { return "asset://" + p; }
        export async function ensureAssetPathsAllowed() {}
        export function getFilePathForDroppedFile() { return ""; }
        export async function ensureThumbnail() { return null; }
        export async function deleteImage() {}
        export default {};` };
    }
    return nextLoad(url, context);
  },
});

const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href);
const { nodeExecutor } = await import(pathToFileURL(path.join(SRC, "services/nodeExecutor.ts")).href);

const C = "th-canvas", N = "th-node";
const OLD_THUMB = "C:/old/thumbs/previous-manual-run.webp";
const OLD_THUMBS = [OLD_THUMB];
const base = () => ({
  ...getDefaultImageGeneratorData(),
  prompt: "thumb overwrite probe",
  // 前置：节点上已有一次手动生成留下的缩略图与路径
  status: "success",
  outputImagePath: "C:/old/images/previous-manual-run.png",
  outputImagePaths: ["C:/old/images/previous-manual-run.png"],
  outputThumbPath: OLD_THUMB,
  outputThumbPaths: OLD_THUMBS,
});

useFlowStore.setState({ nodes: [{ id: N, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: base() }], edges: [] });
useCanvasStore.setState({
  activeCanvasId: C,
  canvases: [{ id: C, name: "th", nodes: [{ id: N, type: "imageGeneratorNode", position: { x: 0, y: 0 }, data: base() }], edges: [] }],
});

console.log("=".repeat(78));
console.log(`LABEL=${LABEL}`);
console.log(`  前置 outputThumbPath  = ${JSON.stringify(OLD_THUMB)}`);
console.log(`  前置 outputThumbPaths = ${JSON.stringify(OLD_THUMBS)}`);
await nodeExecutor.executeNode(useFlowStore.getState().nodes.find((n) => n.id === N), C);
await new Promise((r) => setTimeout(r, 60));
const d = useFlowStore.getState().nodes.find((n) => n.id === N).data;
console.log(`  后置 outputThumbPath  = ${JSON.stringify(d.outputThumbPath)}`);
console.log(`  后置 outputThumbPaths = ${JSON.stringify(d.outputThumbPaths)}`);
console.log(`  后置 outputImagePath  = ${JSON.stringify(d.outputImagePath)}`);
console.log(`  后置 status           = ${JSON.stringify(d.status)}`);
console.log(`  结论                  = ${d.outputThumbPath === OLD_THUMB ? "旧缩略图被保留" : "旧缩略图被抹掉/替换"}`);
console.log("=".repeat(78));
