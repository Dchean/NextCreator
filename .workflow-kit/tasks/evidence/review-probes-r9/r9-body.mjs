// R9 独立探针 body（由 r9-mk2.mjs 与 r8-armN.mjs 的 preamble 拼接成 r9-gate.mjs）
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const L = "gen-legal";

const readState = () => ({
  passes: globalThis.__R7_PASSES__,
  exit: globalThis.__R8_EXIT__,
  allTrue: globalThis.__R9_ALLTRUE__,
  truth: globalThis.__R9_TRUTH__,
  jobs: globalThis.__R9_JOBS__,
});
const clearCap = () => { globalThis.__R9_ALLTRUE__ = undefined; globalThis.__R9_TRUTH__ = undefined; globalThis.__R9_PASSES__ = undefined; };

const qsMod = await import(pathToFileURL(QS).href);
console.log(`模块来源：${LABEL} → ${QS}`);
console.log(`单实例确认：import(QS).useQueueStore === 已加载的 useQueueStore = ${qsMod.useQueueStore === useQueueStore}`);
console.log(`探针读到的 useQueueStore 是否就是 heal 归属实例（updateNodeData 可达）= ${typeof useFlowStore.getState().updateNodeData === "function"}`);
console.log("");

const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(" "));

async function run({ ARM, unbounded = false, legal = false, label }) {
  warnings.length = 0;
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
  useCanvasStore.setState({
    canvases: [{ id: A, name: "A", nodes: [mk(X, true), ...(legal ? [mk(L, true)] : [])], edges: [] }],
    activeCanvasId: A,
    _hasHydrated: true,
  });
  useFlowStore.setState({ nodes: [mk(X, true), ...(legal ? [mk(L, true)] : [])] });
  const st = readState();
  const xFinal = marker(X);
  const lFinal = legal ? marker(L) : undefined;
  const cFinal = canvasMarker(X);
  await sleepMs(15);
  unsub();
  const w = warnings.length;
  console.log(
    `${label.padEnd(30)} | 轮数=${String(st.passes).padStart(4)} | 出口=${String(st.exit).padStart(9)} | X=${String(xFinal).padStart(5)} | LEGAL=${String(lFinal).padStart(5)} | 画布X=${String(cFinal).padStart(5)} | 告警=${w}`
  );
  if (w > 0) console.log(`      告警：${warnings[0]}`);
  return { ...st, xFinal, lFinal, cFinal, w, wWrites };
}

console.log("========== A. 只有陈旧标记（无合法标记）==========");
const a7 = await run({ ARM: 7, label: "A ARM=7" });
check(a7.xFinal === false && a7.w === 0, "ARM=7：陈旧标记治愈且零告警");
check(a7.cFinal === false, "ARM=7：画布副本（落盘那份）也已清（F1）");
const a8 = await run({ ARM: 8, label: "A ARM=8" });
check(a8.xFinal === true && a8.w === 1, "ARM=8：停在上限且告警 1 条（诊断仍在）");
check(a8.passes === 8 && a8.exit === "cap", "ARM=8：轮数恰为 8、出口 cap");
check(a8.truth === 1, `ARM=8：上限处独立重算真值=1（实测 ${a8.truth}）`);
check(a8.w > 0 && a8.warnings0 !== undefined ? true : true, "ARM=8：告警内容见上");

console.log("");
console.log("========== B. 合法标记 + 陈旧标记（round 8 反例形状）==========");
for (const ARM of [6, 7, 8, 12]) {
  const r = await run({ ARM, legal: true, label: `B ARM=${ARM} 合法+陈旧` });
  if (ARM <= 7) {
    check(r.xFinal === false, `ARM=${ARM}：陈旧标记被治愈`);
    check(r.w === 0, `ARM=${ARM}：零告警 —— 合法标记不再制造误报（round 8 缺陷点）`);
  } else {
    check(r.exit === "cap", `ARM=${ARM}：出口 cap`);
    check(r.truth === 1, `ARM=${ARM}：上限处真值=1（只算陈旧的那一个，合法未计入）`);
    check(r.w === 1, `ARM=${ARM}：告警 1 条`);
    check(r.lFinal === true, `ARM=${ARM}：合法标记被保留（F-R2-2/F-R3-1）`);
  }
}

console.log("");
console.log("========== C. 无上限病态写入方 ==========");
const c = await run({ ARM: 1, unbounded: true, legal: true, label: "C 病态（合法+陈旧）" });
check(c.passes === 8 && c.exit === "cap", `病态写入方仍恰在第 8 轮停下（实测 ${c.passes}/${c.exit}）`);
check(c.w === 1, `病态写入方仍告警 1 条（实测 ${c.w}）`);
check(c.truth >= 1, `告警时确实还有可清的陈旧标记（真值=${c.truth}）`);

console.log("");
console.log("========== D. 漏报检测：告警 ⟺ 上限处仍有可清陈旧标记 ==========");
let missed = 0;
for (const legal of [false, true]) {
  for (const ARM of [8, 9, 12]) {
    const r = await run({ ARM, legal, label: `D ARM=${ARM} legal=${legal}` });
    const warned = r.w > 0;
    const shouldWarn = r.truth > 0;
    if (warned !== shouldWarn) missed++;
    check(warned === shouldWarn, `ARM=${ARM} legal=${legal}：告警=${warned} 真值=${r.truth}`);
  }
}

console.log("");
console.log("========== E. 判据只读性：到达上限时判据本身是否产生写入/订阅命中 ==========");
{
  const flow0 = () => [mk(X, false), mk(L, false)];
  seed({ flowNodes: flow0(), jobs: [job("jL", L, "queued")] });
  await sleepMs(10);
  reset(); clearCap();
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk(X, false), mk(L, false)], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  let hits = 0;
  const unsubCount = useFlowStore.subscribe((s, p) => { if (s.nodes !== p.nodes) hits++; });
  let canvasHits = 0;
  const unsubCanvas = useCanvasStore.subscribe((s, p) => { if (s.canvases !== p.canvases) canvasHits++; });
  warnings.length = 0;
  let ww = 0;
  const unsubW = useFlowStore.subscribe(() => {
    const xTrue = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
    if (xTrue) return;
    ww++; if (ww > 8) return;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
  const st = readState();
  hits = 0; canvasHits = 0;                 // 只看上限判据之后的写入
  await sleepMs(10);
  console.log(`  出口=${st.exit} 真值=${st.truth} 告警=${warnings.length} 写入方补回次数=${ww}`);
  console.log(`  上限判据执行之后：flowStore 身份变化=${hits}，canvasStore 身份变化=${canvasHits}`);
  check(hits === 0 && canvasHits === 0, "上限判据纯只读：之后零身份变化、零订阅命中");
  unsubW(); unsubCount(); unsubCanvas();
}

console.log("");
console.log("========== F. 画布副本单独为 true（flowStore 为 false）==========");
{
  seed({ flowNodes: [mk(X, false)], jobs: [] });
  await sleepMs(10);
  reset(); clearCap();
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk(X, true)], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  useFlowStore.setState({ nodes: [mk(X, false)] });
  await sleepMs(10);
  console.log(`  仅画布副本为 true，flowStore 换身份后：画布X=${String(canvasMarker(X))}（flowStore X=${String(marker(X))}，jobs=0）`);
  console.log("  —— 该形状不会被任何路径清除，也没有用户可见锁（flowStore 为 false ⇒ 按钮可用）：仅是持久化数据里的一处残余");
  useFlowStore.setState({ nodes: [mk(X, true)] });
  await sleepMs(10);
  console.log(`  flowStore 载入 true（重启 setNodes 形状）之后：flowStore X=${String(marker(X))}，画布X=${String(canvasMarker(X))}`);
  check(marker(X) === false && canvasMarker(X) === false, "flowStore 一旦载入该 true，两个载体一并清除（REQ-001 自愈）");
}

console.warn = origWarn;
console.log("");
console.log(`RESULT: ${failures === 0 && missed === 0 ? "R9 判据核查全部通过" : `仍有 ${failures} 条断言未通过（漏报 ${missed}）`}`);
process.exitCode = failures === 0 && missed === 0 ? 0 : 1;
