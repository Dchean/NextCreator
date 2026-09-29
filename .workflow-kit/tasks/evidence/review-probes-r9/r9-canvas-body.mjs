// R9 probe: can the new stillClearable gate MISS a stale marker that lives only on the
// persisted canvasStore copy? (PRIMARY concern #1)
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const L = "gen-legal";
let bad = 0;
const ck = (ok, label) => { if (!ok) bad++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`); };

const qsMod = await import(pathToFileURL(QS).href);
console.log(`module source: ${LABEL}`);
console.log(`single instance: ${qsMod.useQueueStore === useQueueStore}`);
console.log("");

const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(" "));
const setCanvas = (nodes) => useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes, edges: [] }], activeCanvasId: A, _hasHydrated: true });

// H1: the gate's own truth criterion, computed the same way the code does.
// Question: if the ONLY stale true lives on the canvasStore copy (flowStore already false),
// can the cap branch be reached with a stale marker remaining while stillClearable === 0?
console.log("H1: cap reached with a stale true ONLY on the persisted canvas copy");
{
  warnings.length = 0;
  seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
  await sleepMs(10);
  reset();
  warnings.length = 0;
  // canvas copy of X is stale true; flowStore copy of X is false
  setCanvas([mk(X, true), mk(L, true)]);
  // unbounded pathological writer keeps re-arming flowStore's X -> forces the cap
  let w = 0;
  const unsub = useFlowStore.subscribe(() => {
    const t = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
    if (t) return;
    w++;
    if (w > 50) return;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
  const st = { passes: globalThis.__R7_PASSES__, exit: globalThis.__R8_EXIT__, truth: globalThis.__R9_TRUTH__ };
  await sleepMs(10);
  unsub();
  const xF = marker(X), cF = canvasMarker(X);
  console.log(`  exit=${st.exit} passes=${st.passes} flowStore X=${xF} canvas X=${cF} warns=${warnings.length} gateTruth(at cap)=${st.truth}`);
  ck(st.truth >= 1, "at the cap, the gate's own criterion is >=1 whenever flowStore still holds a stale true");
  ck(xF === true, "pathological writer keeps flowStore X true (cap path)");
  ck(warnings.length === 1, "warning fires on this path (diagnostic alive)");
}

// H2: the decisive question -- cap reached, flowStore's stale true healed, canvas copy still stale.
// Can this happen? The gate scans flowStore only. Show what actually occurs.
console.log("");
console.log("H2: bounded writer; after the cap, is flowStore's X healed while canvas X is still true?");
{
  warnings.length = 0;
  seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
  await sleepMs(10);
  reset();
  warnings.length = 0;
  setCanvas([mk(X, true), mk(L, true)]);
  let w = 0;
  const unsub = useFlowStore.subscribe(() => {
    const t = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
    if (t) return;
    w++;
    if (w > 12) return;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
  const st = { passes: globalThis.__R7_PASSES__, exit: globalThis.__R8_EXIT__, truth: globalThis.__R9_TRUTH__ };
  await sleepMs(10);
  unsub();
  const xF = marker(X), cF = canvasMarker(X);
  console.log(`  exit=${st.exit} flowStore X=${xF} canvas X=${cF} warns=${warnings.length} gateTruth=${st.truth}`);
  // The gate reads flowStore. If flowStore X is already false at the cap moment, gateTruth would be 0.
  ck(!(st.exit === "cap" && xF === false && st.truth === 0 && warnings.length === 1),
     "no spurious warning: whenever the warning fires, flowStore still holds a clearable stale marker");
}

// H3: positive control -- force gateTruth to 0 at the cap and confirm no warning is printed
// (i.e. the gate genuinely suppresses, and ask whether that suppression could hide a canvas-only stale).
console.log("");
console.log("H3: does a canvas-only stale true EVER reach the cap with flowStore already clean?");
{
  let hit = 0;
  for (let arm = 8; arm <= 14; arm++) {
    warnings.length = 0;
    seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
    await sleepMs(6);
    reset();
    warnings.length = 0;
    setCanvas([mk(X, true), mk(L, true)]);
    let w = 0;
    const unsub = useFlowStore.subscribe(() => {
      const t = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
      if (t) return;
      w++; if (w > arm) return;
      useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
    });
    useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
    const st = { exit: globalThis.__R8_EXIT__, truth: globalThis.__R9_TRUTH__ };
    await sleepMs(6);
    unsub();
    const xF = marker(X), cF = canvasMarker(X), wn = warnings.length;
    const shape = st.exit === "cap" && xF === false && cF === true;
    if (shape) hit++;
    console.log(`  arm=${String(arm).padStart(2)} exit=${String(st.exit).padStart(9)} flowX=${String(xF).padStart(5)} canvasX=${String(cF).padStart(5)} warns=${wn} gateTruth=${st.truth}${shape ? "  <-- cap with canvas-only stale" : ""}`);
  }
  ck(hit === 0, "no arm produces 'cap + flowStore clean + canvas still stale' (gate cannot miss that way)");
}

console.warn = origWarn;
console.log("");
console.log(`RESULT: ${bad === 0 ? "gate cannot miss a canvas-only stale marker on the cap path" : `${bad} assertion(s) failed`}`);
process.exitCode = bad === 0 ? 0 : 1;
