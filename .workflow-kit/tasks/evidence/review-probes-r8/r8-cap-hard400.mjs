/**
 * 独立审查探针 R7-A（round 7）：自愈循环的上限 MAX_HEAL_PASSES 的终止性/必要性/代价。
 * 用法：
 *   node --experimental-strip-types r7-cap.mjs                       # 真实候选（插桩副本）
 *   set R7_QS=<path> && node ... r7-cap.mjs                          # 指定 queueStore 副本
 * 插桩：R7_INSTR=1 时用 %TEMP% 的插桩副本（仅在 passes/predicate 处注入 globalThis 计数，行为不变）
 */
import { registerHooks, createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "D:\\NextCreator";
const SRC = path.join(REPO, "src");
const REAL = path.join(SRC, "stores/queueStore.ts");
const TMP = path.join(process.env.TEMP, "r7review");
const X = "gen-x";
const A = "canvas-a";

// —— 生成插桩副本 / 无上限突变体 ——
const realSrc = readFileSync(REAL, "utf8");
function instrument(src) {
  let s = src;
  const before = s;
  s = s.replace("      passes += 1;", "      passes += 1; globalThis.__R7_PASSES__ = passes;");
  s = s.replace(
    "  const hasActiveJob = jobs.some((job) => job.nodeId === nodeId && isActiveJob(job));",
    "  globalThis.__R7_PRED__ = (globalThis.__R7_PRED__ || 0) + 1;\n  const hasActiveJob = jobs.some((job) => job.nodeId === nodeId && isActiveJob(job));"
  );
  if (s === before) throw new Error("插桩锚点未命中：源码结构已变，探针失效（不是候选缺陷）");
  const nPass = (s.match(/globalThis\.__R7_PASSES__ = passes;/g) || []).length;
  const nPred = (s.match(/globalThis\.__R7_PRED__ = \(globalThis\.__R7_PRED__ \|\| 0\) \+ 1;/g) || []).length;
  if (nPass !== 1 || nPred !== 1) throw new Error(`插桩锚点计数异常 pass=${nPass} pred=${nPred}，探针失效`);
  return s;
}
const INST = path.join(TMP, "qs-inst.ts");
writeFileSync(INST, instrument(realSrc), "utf8");
const NOCAP = path.join(TMP, "qs-nocap.ts");
writeFileSync(NOCAP, instrument(realSrc).replace("const MAX_HEAL_PASSES = 8;", "const MAX_HEAL_PASSES = Number.POSITIVE_INFINITY;"), "utf8");
const NOCAP_OK = readFileSync(NOCAP, "utf8").includes("Number.POSITIVE_INFINITY") &&
  readFileSync(NOCAP, "utf8").includes("__R7_PASSES__");

const QS = process.env.R7_QS && existsSync(process.env.R7_QS) ? process.env.R7_QS : INST;
const LABEL = QS === INST ? "真实候选（插桩副本）" : QS === NOCAP ? "突变体（MAX_HEAL_PASSES=∞）" : QS;

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
    // 关键：强制全仓库只有**一份** queueStore 实例（否则 @/stores/queueStore 会解析到真实源码，
    // 出现两个实例、两条 heal 订阅、两份 jobs —— 突变体实验会被真实实例的上限污染）
    if (spec === "@/stores/queueStore" || spec === "../stores/queueStore" || spec === "./queueStore")
      return { url: pathToFileURL(QS).href, shortCircuit: true };
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
const { useQueueStore } = await import(pathToFileURL(QS).href);
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
const reset = () => { globalThis.__R7_PASSES__ = 0; globalThis.__R7_PRED__ = 0; };

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`); };
function seed({ flowNodes, jobs = [] }) {
  useQueueStore.setState({ jobs, paused: true, concurrency: 1 });
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: flowNodes.map((n) => mk(n.id, n.data?.queued)), edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: flowNodes, edges: [], history: [], historyIndex: -1 });
}

console.log(`模块来源：${LABEL} → ${QS}`);
console.log(`突变体确认（MAX_HEAL_PASSES=∞ 且插桩就位）：${NOCAP_OK}`);
console.log("");

console.log("========== A. 正常路径：轮数/predicate 调用/自写身份变化 计数（插桩实测，不采信注释）==========");
{
  seed({ flowNodes: [mk(X, false)] });
  await sleep(15);
  reset();
  let identityChanges = 0, healPendingObserved = 0;
  const unsub = useFlowStore.subscribe((s, p) => { if (s.nodes !== p.nodes) identityChanges++; });
  const trigger = [mk(X, true)];
  useFlowStore.setState({ nodes: trigger });
  const syncPasses = globalThis.__R7_PASSES__;
  await sleep(40);
  unsub();
  console.log(`  轮数=${syncPasses} predicate=${globalThis.__R7_PRED__} 身份变化（含触发）=${identityChanges} 最终标记=${JSON.stringify(marker(X))} 画布副本=${JSON.stringify(canvasMarker(X))}`);
  check(syncPasses === 1, `正常路径轮数 = 1（实际 ${syncPasses}）`);
  check(globalThis.__R7_PRED__ === 1, `正常路径 predicate 调用 = 1（实际 ${globalThis.__R7_PRED__}）`);
  check(identityChanges - 1 === 1, `正常路径治疗自身只写 1 次（实际 ${identityChanges - 1}）`);
  check(marker(X) === false && canvasMarker(X) === false, "标记在所有载体被清");
}

console.log("");
console.log("========== B. 病态写入方（每次收到通知就**重新塞回**一个陈旧 true）+ 上限：是否停在上限 ==========");
{
  seed({ flowNodes: [mk(X, false)] });
  await sleep(15);
  reset();
  // 这正是注释声称"唯一能让循环不退出"的那一类：写入方**只**在看不到 true 时写回 X=true。
  // 单独运行时它自身有界（写完一次就看到 true），但每次自愈把它清掉它都会再写回 ⇒ 振荡。
  let wWrites = 0;
  const HARD = 400; // 探针自保闸
  const unsubW = useFlowStore.subscribe(() => {
    const anyTrue = useFlowStore.getState().nodes.some((n) => n.data?.queued === true);
    if (anyTrue) return;
    wWrites++;
    if (wWrites > HARD) return;
    useFlowStore.setState({
      nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)),
    });
  });
  const t0 = Date.now();
  let threw = null;
  try { useFlowStore.setState({ nodes: [mk(X, true)] }); } catch (e) { threw = e.message; }
  const ms = Date.now() - t0;
  const passesAtReturn = globalThis.__R7_PASSES__;
  await sleep(40);
  unsubW();
  console.log(`  同步栈耗时=${ms}ms 同步返回时轮数=${passesAtReturn} W 写入=${wWrites}（硬闸 ${HARD}）异常=${threw ?? "无"}`);
  check(!threw, "不抛异常（上限是 break，不是 throw）");
  if (QS === NOCAP) {
    check(wWrites > HARD, `突变体（MAX_HEAL_PASSES=∞）跑满探针硬闸仍不停（W 写入=${wWrites}）→ 上限确实必要`);
    console.log(`  ⇒ 无上限突变体：轮数=${passesAtReturn}，只有探针自己的硬闸能让它停；本地环境无此闸 ⇒ 同一同步栈永不返回（UI 冻结）。`);
  } else {
    check(passesAtReturn === 8, `真实候选停在上限：同步返回时轮数 = 8（实际 ${passesAtReturn}）`);
    check(wWrites === 8, `自愈只让写入方多写了 8 次后退出（实际 ${wWrites}）`);
    console.log(`  ⇒ 上限承载终止性：${ms}ms 内 8 轮结束（对照突变体一行）。`);
  }
}

console.log("");
console.log("========== C. 上限的代价：退出时是否残留**可达**的陈旧标记？后续身份变化能否治愈？==========");
{
  seed({ flowNodes: [mk(X, false)] });
  await sleep(15);
  reset();
  // 条件型写入方（r6-fix2-defer ⑥ 同形）：看不到任何 true 就写回 X=true。它在"看到 true"后静默。
  let wWrites = 0;
  const HARD = 60;
  const unsubW = useFlowStore.subscribe(() => {
    const anyTrue = useFlowStore.getState().nodes.some((n) => n.data?.queued === true);
    if (anyTrue) return;
    wWrites++;
    if (wWrites > HARD) return;
    useFlowStore.setState({
      nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)),
    });
  });
  useFlowStore.setState({ nodes: [mk(X, true)] });
  const passesAtReturn = globalThis.__R7_PASSES__;
  const residualAtReturn = marker(X);
  await sleep(40);
  unsubW(); // 必须先停掉写入方，才能把"后续身份变化能否治愈"归因给自愈本身
  console.log(`  同步返回时：轮数=${passesAtReturn} W 写入=${wWrites} 残留标记=${JSON.stringify(residualAtReturn)}`);
  const residualAfterQuiesce = marker(X);
  console.log(`  写入方静默 40ms 后（无新身份变化）：标记=${JSON.stringify(residualAfterQuiesce)} 画布副本=${JSON.stringify(canvasMarker(X))}`);
  // "下一次 nodes 换身份会重新复核" —— 兑现测试：做一次**良性**身份变化（内容不变的新数组）
  useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => ({ ...n })) });
  await sleep(30);
  const afterBenign = marker(X);
  console.log(`  一次良性身份变化后：标记=${JSON.stringify(afterBenign)}`);
  check(residualAtReturn === true, `上限退出时 X 仍为 true（陈旧标记残留，实际 ${JSON.stringify(residualAtReturn)}）`);
  check(afterBenign === false, `承诺兑现：后续身份变化确实复核并治愈（实际 ${JSON.stringify(afterBenign)}）`);
}

console.log("");
console.log("========== D. 上限不得吞掉**合法**标记，也不得在上限内漏治 ==========");
{
  seed({ flowNodes: [mk(X, false)], jobs: [job("j1", X, "queued")] });
  await sleep(15);
  reset();
  useFlowStore.setState({ nodes: [mk(X, true)] });
  const passes = globalThis.__R7_PASSES__;
  await sleep(30);
  console.log(`  有 queued 任务时：轮数=${passes} 谓词=${globalThis.__R7_PRED__} 标记=${JSON.stringify(marker(X))} 画布副本=${JSON.stringify(canvasMarker(X))}`);
  check(marker(X) === true && canvasMarker(X) === true, "合法标记（该 nodeId 真有 queued 任务）被保留");
  check(passes === 1, `无嵌套写入时 1 轮即退出（实际 ${passes}）`);
  check(globalThis.__R7_PRED__ === 1, `谓词只调用 1 次（实际 ${globalThis.__R7_PRED__}）`);
}

console.log("");
console.log("========== E. 上限检查点的位置：有界写入方（补 N 次即停）是否触发**误报**警告？==========");
{
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  for (const ARM of [9, 12]) {
    seed({ flowNodes: [mk(X, false)] });
    await sleep(15);
    reset();
    warnings.length = 0;
    let wWrites = 0;
    const unsubW = useFlowStore.subscribe(() => {
      const anyTrue = useFlowStore.getState().nodes.some((n) => n.data?.queued === true);
      if (anyTrue) return;
      wWrites++;
      if (wWrites > ARM) return; // 自身有界：补 ARM 次即永久停手
      useFlowStore.setState({
        nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)),
      });
    });
    useFlowStore.setState({ nodes: [mk(X, true)] });
    const passes = globalThis.__R7_PASSES__;
    const warnsAtReturn = warnings.length;
    await sleep(30);
    unsubW();
    const healed = marker(X) === false;
    console.log(`  补 ${ARM} 次的有界写入方：轮数=${passes} 警告数=${warnsAtReturn} 最终标记=${JSON.stringify(marker(X))} 已治愈=${healed}`);
    if (warnsAtReturn > 0) console.log(`    警告原文：${warnings[0].slice(0, 120)}`);
    console.warn = origWarn;
    check(!(healed && warnsAtReturn > 0) || QS === NOCAP,
      `有界写入方补 ${ARM} 次：第 ${ARM} 轮已把最后一个陈旧 true 清掉（标记=${JSON.stringify(marker(X))}），` +
      `却在"仍有陈旧标记未复核"的措辞下发出 ${warnsAtReturn} 条警告`);
    console.warn = (...a) => { warnings.push(a.join(" ")); };
  }
  console.warn = origWarn;
}

console.log("");
console.log(`RESULT: ${failures === 0 ? "上限终止性/必要性/代价核查通过" : `仍有 ${failures} 条断言未通过`}  [${LABEL}]`);
process.exitCode = failures === 0 ? 0 : 1;
