// R9 decisive: can the gate report 0 while a genuine stale marker remains, because the stale
// marker lives ONLY on the persisted canvasStore copy while flowStore's copy is false?
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const L = "gen-legal";
const qsMod = await import(pathToFileURL(QS).href);
console.log(`module source: ${LABEL}`);
console.log(`single instance: ${qsMod.useQueueStore === useQueueStore}`);
console.log("");
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(" "));
const setCanvas = (nodes) => useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes, edges: [] }], activeCanvasId: A, _hasHydrated: true });

console.log("Shape: L = legal marker (real queued job, predicate keeps it); X = stale true ONLY on canvas copy");
console.log("       (flowStore X already false, no job) + a writer that re-arms L's marker (new identity) N times.");
console.log("");
for (const N of [4, 20]) {
  warnings.length = 0;
  seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
  await sleepMs(8);
  reset();
  warnings.length = 0;
  setCanvas([mk(X, true), mk(L, true)]);   // persisted copy of X is stale true; flowStore's is false
  let w = 0;
  const unsub = useFlowStore.subscribe(() => {
    if (w >= N) return;
    w++;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === L ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  useFlowStore.setState({ nodes: [mk(X, false), mk(L, true)] });
  const st = { passes: globalThis.__R7_PASSES__, exit: globalThis.__R8_EXIT__, truth: globalThis.__R9_TRUTH__ };
  await sleepMs(8);
  unsub();
  console.log(`  N=${String(N).padStart(2)} | passes=${String(st.passes).padStart(4)} | exit=${String(st.exit).padStart(9)} | flowX=${String(marker(X)).padStart(5)} | canvasX=${String(canvasMarker(X)).padStart(5)} | flowL=${String(marker(L)).padStart(5)} | warns=${warnings.length} | gateCount(at cap)=${st.truth}`);
  const hit = st.exit === "cap" && st.truth === 0 && warnings.length === 0 && canvasMarker(X) === true;
  console.log(`       shape reached? ${hit ? "YES -- cap + gate 0 + no warning + canvas copy still stale true" : "no"}`);
}
console.log("");
console.log("Control: same writer, but X's flowStore copy re-armed instead (the round-8 shape) -> gate must be >=1 and warn");
{
  warnings.length = 0;
  seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
  await sleepMs(8);
  reset();
  warnings.length = 0;
  setCanvas([mk(X, true), mk(L, true)]);
  let w = 0;
  const unsub = useFlowStore.subscribe(() => {
    const t = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
    if (t) return;
    if (w >= 20) return;
    w++;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
  const st = { passes: globalThis.__R7_PASSES__, exit: globalThis.__R8_EXIT__, truth: globalThis.__R9_TRUTH__ };
  await sleepMs(8);
  unsub();
  console.log(`  control | passes=${st.passes} | exit=${st.exit} | gateCount=${st.truth} | warns=${warnings.length}`);
}
console.warn = origWarn;
