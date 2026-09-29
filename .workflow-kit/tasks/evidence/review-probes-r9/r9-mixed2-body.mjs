// R9 targeted probe: tests the NEW comment claim at :988-989 that with a legal marker present
// the exit is "necessarily" the cap branch.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const L = "gen-legal";
let bad2 = 0;
const check2 = (ok, label) => { if (!ok) bad2++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`); };

const qsMod = await import(pathToFileURL(QS).href);
console.log(`module source: ${LABEL}`);
console.log(`single-instance check: ${qsMod.useQueueStore === useQueueStore}`);
console.log("");
console.log("Claim at :988-989: with one more LEGAL marker present (another node with a real queued job),");
console.log("the rescan is never empty, so candidates.length===0 never hits and the exit is NECESSARILY cap.");
console.log("");

const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(" "));

async function scenario({ label, oneShotWrite }) {
  warnings.length = 0;
  seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
  await sleepMs(10);
  reset();
  warnings.length = 0;
  useCanvasStore.setState({ canvases: [{ id: A, name: "A", nodes: [mk(X, false), mk(L, false)], edges: [] }], activeCanvasId: A, _hasHydrated: true });
  let unsub = null;
  globalThis.__R9_DONE__ = false;
  if (oneShotWrite) {
    unsub = useFlowStore.subscribe(() => {
      if (globalThis.__R9_DONE__) return;
      globalThis.__R9_DONE__ = true;
      useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
    });
  }
  useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
  const st = { passes: globalThis.__R7_PASSES__, exit: globalThis.__R8_EXIT__ };
  const xF = marker(X), lF = marker(L);
  await sleepMs(15);
  if (unsub) unsub();
  globalThis.__R9_DONE__ = false;
  console.log(`${label.padEnd(44)} | passes=${String(st.passes).padStart(3)} | exit=${String(st.exit).padStart(9)} | X=${String(xF).padStart(5)} | LEGAL=${String(lF).padStart(5)} | warns=${warnings.length}`);
  return { ...st, xF, lF, w: warnings.length };
}

const g1 = await scenario({ label: "G1 legal + stale (one-shot whole-array write)", oneShotWrite: true });
check2(g1.exit === "cap", `comment says exit is necessarily cap -> measured exit=${g1.exit}`);
check2(g1.xF === false, "G1: stale marker healed");
check2(g1.lF === true, "G1: legal marker preserved");
check2(g1.w === 0, "G1: zero warnings");

const g2 = await scenario({ label: "G2 legal + stale (no writer)", oneShotWrite: false });
check2(g2.exit === "cap", `comment says exit is necessarily cap -> measured exit=${g2.exit}`);
check2(g2.xF === false, "G2: stale marker healed");
check2(g2.w === 0, "G2: zero warnings");

warnings.length = 0;
seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
await sleepMs(10);
reset();
useFlowStore.setState({ nodes: [mk(X, false), mk(L, true)] });
const g3 = { passes: globalThis.__R7_PASSES__, exit: globalThis.__R8_EXIT__ };
console.log(`${"G3 legal only (no stale marker)".padEnd(44)} | passes=${String(g3.passes).padStart(3)} | exit=${String(g3.exit).padStart(9)} | warns=${warnings.length}`);

console.warn = origWarn;
console.log("");
console.log(`RESULT: ${bad2 === 0 ? "the new comment's necessity claim holds in all arms" : `${bad2} measured counterexample(s) to the necessity claim`}`);
process.exitCode = bad2 === 0 ? 0 : 1;
