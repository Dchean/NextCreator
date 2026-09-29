/**
 * WORKER 修复证据（round 9，评论订正）：证明 queueStore.ts 自愈循环里的**三个出口**分别由什么形状走到，
 * 并据此核对 :974-979 那条订正后的注释（"有合法标记时零候选不命中；真实出口取决于本轮有无嵌套写入"）。
 *
 * 与 r8-armN.mjs / r9-gate.mjs 同构：
 *   · registerHooks 把 "@/stores/queueStore" / "../stores/queueStore" / "./queueStore" 一律短路到**同一份**
 *     插桩副本 ⇒ 全仓库只有一个 queueStore 实例（两个实例会有两条 heal 订阅，测量作废）；
 *   · 插桩只在三个 break 处注入一个 globalThis 出口标签 + 轮数计数，**不改任何逻辑**；
 *   · 断言单实例（import(QS).useQueueStore === 已加载的 useQueueStore）。
 * 用法：node --experimental-strip-types probe-r9-exits.mjs
 */
import { registerHooks, createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const REAL = path.join(SRC, "stores/queueStore.ts");
const TMP = path.join(process.env.TEMP, "r9verify");
const X = "gen-x";
const LEGAL = "gen-legal";
const A = "canvas-a";

// —— 插桩副本（三个出口：:948 nopending / :954 zero / :982 cap）——
const realSrc = readFileSync(REAL, "utf8");
function instrument(src) {
  const before = src;
  let s = src;
  s = s.replace("      passes += 1;", "      passes += 1; globalThis.__R9_PASSES__ = passes;");
  s = s.replace("      if (!healPending) break;", "      if (!healPending) { globalThis.__R9_EXIT__ = 'nopending'; break; }");
  s = s.replace("      if (candidates.length === 0) break;", "      if (candidates.length === 0) { globalThis.__R9_EXIT__ = 'zero'; break; }");
  s = s.replace("      if (passes >= MAX_HEAL_PASSES) {", "      if (passes >= MAX_HEAL_PASSES) { globalThis.__R9_EXIT__ = 'cap';");
  const nP = (s.match(/globalThis\.__R9_PASSES__ = passes;/g) || []).length;
  const nE = (s.match(/__R9_EXIT__ = '/g) || []).length;
  if (s === before || nP !== 1 || nE !== 3) throw new Error(`插桩锚点异常 pass=${nP} exit=${nE}：源码结构已变，探针失效`);
  return s;
}
const INST = path.join(TMP, "qs-r9verify-inst.ts");
writeFileSync(INST, instrument(realSrc), "utf8");
// 订正后的注释文本是否真的在源码里（探针顺带核对注释与代码同源）
const editedSrc = readFileSync(REAL, "utf8");
const hasNewClause =
  editedSrc.includes("出口因此取决于本轮有没有发生嵌套写入") &&
  editedSrc.includes("一直非空、`candidates.length === 0` 这一分支**永远不会命中**");
const hasOldClaim =
  editedSrc.includes("出口必然落到下面的上限拦停") ||
  editedSrc.includes("让出口永远是这里") ||
  editedSrc.includes("即便陈旧的那一个已经治好");

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
  for (const c of [p + ".ts", p + ".tsx", path.join(p, "index.ts"), path.join(p, "index.tsx")]) if (existsSync(c)) return c;
  return p;
}
const SILENT = `
export const executeImageGeneration = async () => ({ success: true, cancelled: false });
export const getImageBatchCount = (data) => Math.min(Math.max(data?.n || 1, 1), 4);
`;
registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec === "@/services/imageGenerationExecution") return { url: "mutant:exec", shortCircuit: true };
    // 强制单实例：任何写法都解析到同一份插桩副本
    if (spec === "@/stores/queueStore" || spec === "../stores/queueStore" || spec === "./queueStore")
      return { url: pathToFileURL(INST).href, shortCircuit: true };
    if (spec.startsWith("@/")) return { url: pathToFileURL(withTs(path.join(SRC, spec.slice(2)))).href, shortCircuit: true };
    if (!spec.startsWith(".") && !spec.startsWith("node:") && !spec.startsWith("file:")) {
      try {
        const resolved = createRequire(path.join(REPO, "package.json")).resolve(spec);
        return { url: pathToFileURL(resolved).href, shortCircuit: true };
      } catch { /* 交给默认解析 */ }
    }
    if (spec.startsWith(".") && !path.extname(spec) && context.parentURL) {
      const t = withTs(fileURLToPath(new URL(spec, context.parentURL)));
      if (existsSync(t)) return { url: pathToFileURL(t).href, shortCircuit: true };
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "mutant:exec") return { format: "module", source: SILENT, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { useQueueStore } = await import(pathToFileURL(INST).href);
const { useFlowStore } = await import(pathToFileURL(path.join(SRC, "stores/flowStore.ts")).href);
const { useCanvasStore } = await import(pathToFileURL(path.join(SRC, "stores/canvasStore.ts")).href);
const { getDefaultImageGeneratorData } = await import(
  pathToFileURL(path.join(SRC, "components/nodes/imageGeneratorConfig.ts")).href
);

const D = () => ({ ...getDefaultImageGeneratorData(), prompt: "p", n: 1, status: "idle", label: "L" });
const mk = (id, queued) => ({
  id, type: "imageGeneratorNode", position: { x: 0, y: 0 },
  data: { ...D(), ...(queued === undefined ? {} : { queued }) },
});
const marker = (id) => useFlowStore.getState().nodes.find((n) => n.id === id)?.data?.queued;
const canvasMarker = (id) => useCanvasStore.getState().canvases.find((c) => c.id === A)?.nodes.find((n) => n.id === id)?.data?.queued;
const job = (id, nodeId, status) => ({ id, nodeId, canvasId: A, nodeLabel: "L", modelLabel: "m", promptPreview: "p", status, createdAt: Date.now() });

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`); };

// —— 单实例确认 ——
const qsMod = await import(pathToFileURL(INST).href);
const single = qsMod.useQueueStore === useQueueStore;
console.log(`单实例确认：import(QS).useQueueStore === 已加载 useQueueStore = ${single}`);
check(single, "全仓库只有一份 queueStore 实例（否则测量作废）");
console.log(`注释订正确认：新措辞在源码中=${hasNewClause}；旧必要性断言（"出口必然落到下面的上限拦停"）已移除=${!hasOldClaim}`);
check(hasNewClause && !hasOldClaim, "源码里的注释就是订正后的版本（探针核对的是当前候选）");
console.log("");

// —— seed：flowStore 与画布副本同时给出（画布副本 = 防抖回写的落点）——
function seed({ flowNodes, jobs = [] }) {
  useQueueStore.setState({ jobs, paused: true, concurrency: 1 });
  useCanvasStore.setState({
    canvases: [{ id: A, name: "A", nodes: flowNodes.map((n) => mk(n.id, n.data?.queued)), edges: [] }],
    activeCanvasId: A, _hasHydrated: true,
  });
  useFlowStore.setState({ nodes: flowNodes, edges: [], history: [], historyIndex: -1 });
}
let warns = 0;
const realWarn = console.warn;
console.warn = (...a) => { warns++; realWarn(...a); };

/**
 * 跑一个形状。写入方 = "只要看到 X 不是 true 就整数组写回 X=true"（撤销/重做快照回灌的形状），
 * maxWrites 控制它补回几次（1 = 一次性；Infinity = 每轮都补）。
 * ⚠ 必读：写入方**不能**用"整份 nodes 里没有任何 true"做条件 —— 场景里存在**合法**标记（LEGAL 恒为
 * true）时那个条件永远不成立，写入方一次都不会被触发。这正是"合法标记"对这类写入方的天然免疫，
 * 也是必须用**逐节点**条件才能构造出"每轮都补回"的形状的原因（诊断见 dbg-writer.mjs）。
 */
async function shape(label, seedNodes, maxWrites, trigger) {
  seed({ flowNodes: seedNodes, jobs: [job("jL", LEGAL, "queued")] });
  await sleep(15);
  globalThis.__R9_PASSES__ = 0;
  globalThis.__R9_EXIT__ = undefined;
  warns = 0;
  let wWrites = 0;
  const HARD = 60;
  const unsub = maxWrites > 0 ? useFlowStore.subscribe(() => {
    const nodes = useFlowStore.getState().nodes;
    const xTrue = nodes.find((n) => n.id === X)?.data?.queued === true;
    if (xTrue) return;
    if (wWrites >= maxWrites || wWrites >= HARD) return;
    wWrites++;
    useFlowStore.setState({ nodes: nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  }) : null;
  let threw = null;
  try { useFlowStore.setState({ nodes: trigger() }); } catch (e) { threw = e.message; }
  const passes = globalThis.__R9_PASSES__;
  const exit = globalThis.__R9_EXIT__;
  await sleep(40);
  unsub?.();
  const xF = marker(X), lF = marker(LEGAL), cF = canvasMarker(X);
  console.log(
    `${label.padEnd(34)} | 轮数=${String(passes).padStart(3)} | 出口=${String(exit).padStart(9)} | X=${String(xF).padStart(5)} | LEGAL=${String(lF).padStart(5)} | 画布X=${String(cF).padStart(5)} | 告警=${warns} | W写入=${wWrites} | 异常=${threw ?? "无"}`
  );
  return { passes, exit, xF, lF, cF, warns, wWrites, threw };
}

console.log("========== 三个出口的形状（LEGAL = gen-legal，真有 queued 任务 ⇒ 谓词永不清它）==========");
// (a) LEGAL + 已治愈的陈旧标记 X（X 为 false），无病态写入方
const a = await shape("(a) LEGAL + 已治愈陈旧，无写入方", [mk(X, false), mk(LEGAL, true)], 0, () => [mk(X, true), mk(LEGAL, true)]);
// (b) 一次性整数组写回（撤销形状）：写入方看到 X 不是 true 就补回一次，补完即停手
const b = await shape("(b) 一次性整数组写回（撤销）", [mk(X, false), mk(LEGAL, true)], 1, () => [mk(X, true), mk(LEGAL, true)]);
// (c) 每一轮被清掉就再补回 X=true 的写入方（无界）
const c = await shape("(c) 每轮重新补回的写入方", [mk(X, false), mk(LEGAL, true)], Number.POSITIVE_INFINITY, () => [mk(X, true), mk(LEGAL, true)]);
console.log("");

console.log("========== 与订正后注释逐条对照 ==========");
// 注释①：有合法标记时 candidates.length === 0 永远不命中（出口绝不是 zero）
check(a.exit !== "zero" && b.exit !== "zero" && c.exit !== "zero", `三个形状都不走零候选出口（实际：${a.exit}/${b.exit}/${c.exit}）`);
// 注释②：本轮无嵌套写入 → :948 !healPending 分支先退出，标签 nopending（陈旧标记已治愈、只剩合法标记）
check(a.exit === "nopending", `(a) 已治愈陈旧 + 合法标记 ⇒ nopending（实际 ${a.exit}）`);
check(b.exit === "nopending", `(b) 一次性写回 ⇒ nopending（实际 ${b.exit}）`);
// 注释③：本轮有嵌套写入 → 继续到上限，出口 cap，告警由只读判据 stillClearable 决定
check(c.exit === "cap", `(c) 每轮补回 ⇒ cap（实际 ${c.exit}）`);
check(c.passes === 8, `(c) 上限仍是 8 轮（实际 ${c.passes}）`);
check(c.wWrites === 8, `(c) 写入方被多带 8 次后退出（实际 ${c.wWrites}）`);
// 注释④：cap 处的告警不把"候选非空"当"陈旧标记仍在"的证明：合法标记单独存在时不得告警
check(a.warns === 0 && b.warns === 0, `(a)(b) 出口不是 cap ⇒ 零告警（实际 ${a.warns}/${b.warns}）`);
check(a.lF === true && b.lF === true && c.lF === true, "合法标记在三个形状里都被保留（谓词有意放行）");
check(a.xF === false && b.xF === false, "(a)(b) 陈旧标记确实被治愈（X=false）");
check(a.cF === false && b.cF === false, "(a)(b) 画布副本同步为 false ⇒ 不会跨重启锁死");
check(!a.threw && !b.threw && !c.threw, "三个形状都不抛异常");

console.log("");
console.log(`RESULT: ${failures === 0 ? "PASS" : `FAIL（${failures} 项）`} — 出口实测 (a)=${a.exit}/${a.passes} 轮, (b)=${b.exit}/${b.passes} 轮, (c)=${c.exit}/${c.passes} 轮`);
process.exit(failures === 0 ? 0 : 1);
