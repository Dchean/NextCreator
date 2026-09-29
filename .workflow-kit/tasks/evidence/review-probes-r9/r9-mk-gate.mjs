// 生成 R9 独立探针：复用 r8-armN.mjs 的加载器/工具（前 129 行），并追加"上限处判据"的独立真值采集
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const lines = readFileSync(path.join(dir, "r8-armN.mjs"), "utf8").split(/\r?\n/);
const cut = lines.findIndex((l) => l.startsWith("console.log(`模块来源"));
if (cut < 120) throw new Error(`preamble 边界异常：${cut}`);
let preamble = lines.slice(0, cut).join("\n");

// 在 instrument() 里追加：在上限判据处独立重算"真值"（全数组口径），用于检测"漏报"
const anchor = `  s = s.replace("      if (passes >= MAX_HEAL_PASSES) {", "      if (passes >= MAX_HEAL_PASSES) { globalThis.__R8_EXIT__ = 'cap';");`;
if (!preamble.includes(anchor)) throw new Error("instrument 锚点未命中");
preamble = preamble.replace(
  anchor,
  anchor +
    `\n  s = s.replace(
    "        const stillClearable = candidates.filter(",
    "        globalThis.__R9_ALLTRUE__ = useFlowStore.getState().nodes.filter((n) => n.data?.queued === true).length;\\n" +
      "        globalThis.__R9_TRUTH__ = useFlowStore.getState().nodes.filter((n) => n.data?.queued === true && !useQueueStore.getState().jobs.some((j) => j.nodeId === n.id && (j.status === 'queued' || j.status === 'running'))).length;\\n" +
      "        globalThis.__R9_PASSES__ = passes;\\n" +
      "        globalThis.__R9_JOBS__ = useQueueStore.getState().jobs.map((j) => j.nodeId + ':' + j.status).join(',');\\n" +
      "        const stillClearable = candidates.filter("
  );`
);

const body = String.raw`
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const L = "gen-legal";
let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`); };

const readState = () => ({
  passes: globalThis.__R7_PASSES__,
  exit: globalThis.__R8_EXIT__,
  allTrue: globalThis.__R9_ALLTRUE__,
  truth: globalThis.__R9_TRUTH__,
  jobs: globalThis.__R9_JOBS__,
});
const clearCap = () => { globalThis.__R9_ALLTRUE__ = undefined; globalThis.__R9_TRUTH__ = undefined; globalThis.__R9_PASSES__ = undefined; };

// 单实例确认：两边必须是同一个 store 对象
const qsMod = await import(pathToFileURL(QS).href);
console.log(`模块来源：${LABEL} → ${QS}`);
console.log(`单实例确认：useQueueStore 与模块默认导出一致 = ${qsMod.useQueueStore === useQueueStore}`);
console.log(`useFlowStore 里可见的 queueStore 引用 = ${typeof useFlowStore.getState().updateNodeData === "function" ? "ok" : "?"}`);
console.log("");

async function run({ ARM, unbounded = false, legal = false, canvasCopy = true, label }) {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  const flow = () => [mk(X, false), ...(legal ? [mk(L, false)] : [])];
  seed({ flowNodes: flow(), jobs: legal ? [job("jL", L, "queued")] : [] });
  await sleepMs(10);
  reset(); clearCap();
  warnings.length = 0;
  let wWrites = 0;
  const unsub = useFlowStore.subscribe(() => {
    const xTrue = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
    if (xTrue) return;
    wWrites++;
    if (!unbounded && wWrites > ARM) return;
    useFlowStore.setState({
      nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)),
    });
  });
  // 画布副本也置为 true（检查 F1：落盘副本必须被一并清掉）
  useCanvasStore.setState({
    canvases: [{ id: A, name: "A", nodes: flow().map((n) => mk(n.id, n.id === X ? canvasCopy : n.data?.queued)), edges: [] }],
    activeCanvasId: A,
    _hasHydrated: true,
  });
  // 触发：flowStore 换身份，X 与（可选）合法节点均为 true
  useFlowStore.setState({ nodes: [mk(X, true), ...(legal ? [mk(L, true)] : [])] });
  const st = readState();
  const xFinal = marker(X);
  const lFinal = legal ? marker(L) : undefined;
  const cFinal = canvasMarker(X);
  await sleepMs(15);
  unsub();
  console.warn = origWarn;
  const w = warnings.length;
  console.log(
    `${label.padEnd(34)} | 轮数=${String(st.passes).padStart(3)} | 出口=${String(st.exit).padStart(9)} | X=${String(xFinal).padStart(5)} | LEGAL=${String(lFinal).padStart(5)} | 画布副本X=${String(cFinal).padStart(5)} | 告警=${w}`
  );
  if (w > 0) console.log(`      告警原文：${warnings[0]}`);
  return { ...st, xFinal, lFinal, cFinal, w, warnings, wWrites };
}

console.log("========== A. 只有陈旧标记（无合法标记）：上限告警是否在**该**报时才报 ==========");
const a7 = await run({ ARM: 7, label: "A ARM=7 无合法" });
check(a7.xFinal === false && a7.w === 0, "ARM=7：陈旧标记已治愈且零告警");
check(a7.cFinal === false, "ARM=7：画布副本（落盘那份）也已清掉（F1）");
const a8 = await run({ ARM: 8, label: "A ARM=8 无合法" });
check(a8.xFinal === true && a8.w === 1, "ARM=8：停在上限且告警 1 条（诊断仍在）");
check(a8.passes === 8 && a8.exit === "cap", "ARM=8：轮数恰为 8、出口 cap");
check(a8.truth === 1, `ARM=8：上限处独立重算的真值 =1（实测 ${a8.truth}）`);
check(a8.warnings[0]?.includes("仍有 1 个可清的陈旧 queued 标记"), "ARM=8：告警计数正确（1）");

console.log("");
console.log("========== B. 合法标记 + 陈旧标记（round 8 反例形状）：误报是否消失 ==========");
for (const ARM of [6, 7, 8, 12]) {
  const r = await run({ ARM, legal: true, label: `B ARM=${ARM} 合法+陈旧` });
  if (ARM <= 7) {
    check(r.xFinal === false, `ARM=${ARM}：陈旧标记被治愈`);
    check(r.w === 0, `ARM=${ARM}：零告警 —— 合法标记不得再制造误报（round 8 的缺陷点）`);
  } else {
    check(r.exit === "cap" && r.truth === 1, `ARM=${ARM}：上限处真值=1（陈旧的那一个），合法标记未被计入`);
    check(r.w === 1 && r.warnings[0]?.includes("仍有 1 个可清的陈旧"), `ARM=${ARM}：告警只数陈旧的那一个（不是 2）`);
    check(r.lFinal === true, `ARM=${ARM}：合法标记被保留（F-R2-2/F-R3-1）`);
  }
}

console.log("");
console.log("========== C. 无上限病态写入方：诊断是否仍在、是否仍停在上限 ==========");
const c = await run({ ARM: 1, unbounded: true, label: "C 病态写入方（合法+陈旧）", legal: true });
check(c.passes === 8 && c.exit === "cap", `病态写入方仍恰好在第 8 轮停下（实测轮数=${c.passes} 出口=${c.exit}）`);
check(c.w === 1, `病态写入方仍告警 1 条（实测 ${c.w}）`);
check(c.truth >= 1, `告警时确实还有可清的陈旧标记（真值=${c.truth}）`);

console.log("");
console.log("========== D. 漏报检测：上限处「全数组真值」是否 > 告警计数 ==========");
let missed = 0;
for (const legal of [false, true]) {
  for (const ARM of [8, 9, 12]) {
    const r = await run({ ARM, legal, label: `D ARM=${ARM} legal=${legal}` });
    const warned = r.w > 0;
    const shouldWarn = r.truth > 0;
    if (warned !== shouldWarn) missed++;
    check(warned === shouldWarn, `ARM=${ARM} legal=${legal}：告警=${warned} 而真值=${r.truth}（应一致）`);
  }
}

console.log("");
console.log("========== E. 只读性：判据处是否产生额外写入/身份变化 ==========");
{
  const flow0 = () => [mk(X, false), mk(L, false)];
  seed({ flowNodes: flow0(), jobs: [job("jL", L, "queued")] });
  await sleepMs(10);
  reset(); clearCap();
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: flow0().map((n) => mk(n.id, n.data?.queued)), edges: [] }], activeCanvasId: A, _hasHydrated: true });
  let hits = 0;
  const unsubCount = useFlowStore.subscribe((s, p) => { if (s.nodes !== p.nodes) hits++; });
  let canvasHits = 0;
  const unsubCanvas = useCanvasStore.subscribe((s, p) => { if (s.canvases !== p.canvases) canvasHits++; });
  // 走到上限的路径：无上限式写入方 1 次即足以让轮数达到 8？改用有界 ARM=8 触发 cap
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  const unsubW = useFlowStore.subscribe(() => {
    const xTrue = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
    if (xTrue) return;
    if (globalThis.__R9_W__ && globalThis.__R9_W__ >= 8) return;
    globalThis.__R9_W__ = (globalThis.__R9_W__ || 0) + 1;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  globalThis.__R9_W__ = 0;
  hits = 0; canvasHits = 0;
  useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
  const st = readState();
  hits = 0; canvasHits = 0;              // 只看"上限判据本身"之后是否还有写入
  await sleepMs(10);
  console.log(`  出口=${st.exit} 真值=${st.truth} 告警=${warnings.length}`);
  console.log(`  上限判据执行**之后**的 flowStore 身份变化数=${hits}，canvasStore 身份变化数=${canvasHits}`);
  check(hits === 0 && canvasHits === 0, "上限判据是只读的：判据之后零身份变化（无写入、无订阅命中）");
  globalThis.__R9_W__ = undefined;
  unsubW(); unsubCount(); unsubCanvas();
  console.warn = origWarn;
}

console.log("");
console.log("========== F. 画布副本单独为 true（flowStore 为 false）：判据口径 ==========");
{
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  seed({ flowNodes: [mk(X, false)], jobs: [] });
  await sleepMs(10);
  reset(); clearCap();
  // 只有画布副本是陈旧 true
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk(X, true)], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  // 任何来源的 flowStore 身份变化（内容仍然是 false）
  useFlowStore.setState({ nodes: [mk(X, false)] });
  await sleepMs(10);
  const onlyCanvas = canvasMarker(X);
  console.log(`  flowStore 身份变化后：画布副本 X=${String(onlyCanvas)}（flowStore X=${String(marker(X))}，jobs=0）`);
  // 现在让 flowStore 也载入 true（= 重启时 App.tsx:154 setNodes 的形状）
  useFlowStore.setState({ nodes: [mk(X, true)] });
  await sleepMs(10);
  console.log(`  flowStore 载入 true 之后：flowStore X=${String(marker(X))}，画布副本 X=${String(canvasMarker(X))}`);
  check(marker(X) === false && canvasMarker(X) === false, "flowStore 一旦载入该 true，两个载体被一并清除（REQ-001 自愈）");
  unsubSafe();
  console.warn = origWarn;
  function unsubSafe() {}
}

console.log("");
console.log(`RESULT: ${failures === 0 && missed === 0 ? "R9 判据核查全部通过" : `仍有 ${failures} 条断言未通过（漏报 ${missed}）`}`);
process.exitCode = failures === 0 && missed === 0 ? 0 : 1;
`;

writeFileSync(path.join(dir, "r9-gate.mjs"), preamble + "\n" + body, "utf8");
console.log("written r9-gate.mjs (preamble lines:", cut, ")");
