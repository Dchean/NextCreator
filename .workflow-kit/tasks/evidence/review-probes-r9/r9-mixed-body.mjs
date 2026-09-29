// R9 定向探针：检验新增注�?:988-989 "只要场景里再多一个合法标记…出�?*必然**落到下面的上限拦�?
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const L = "gen-legal";
let bad = 0;
const check2 = (ok, label) => { if (!ok) bad++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`); };

const qsMod = await import(pathToFileURL(QS).href);
console.log(`模块来源�?{LABEL}`);
console.log(`单实例确认：${qsMod.useQueueStore === useQueueStore}`);
console.log("");
console.log("注释 :988-989 的主张：「只要场景里再多一个合法标记（另一节点真有 queued 任务），重扫就永远非空�?);
console.log("这一行[candidates.length===0]永远不命中，出口**必然**落到下面的上限拦停（cap）�?);
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
  if (oneShotWrite) {
    // 一次性整数组写入：撤销/重做把陈�?true 整数组写回（F-R4-1 的真实形状），此后不再写
    unsub = useFlowStore.subscribe(() => {
      if (globalThis.__R9_DONE__) return;
      globalThis.__R9_DONE__ = true;
      useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
    });
  }
  globalThis.__R9_DONE__ = false;
  // 触发：合法标�?L（真�?queued 任务�? 陈旧标记 X（一次性写回）
  useFlowStore.setState({ nodes: [mk(X, true), mk(L, true)] });
  const st = { passes: globalThis.__R7_PASSES__, exit: globalThis.__R8_EXIT__ };
  const xF = marker(X), lF = marker(L);
  await sleepMs(15);
  if (unsub) unsub();
  globalThis.__R9_DONE__ = false;
  console.log(`${label.padEnd(46)} | 轮数=${String(st.passes).padStart(3)} | 出口=${String(st.exit).padStart(9)} | X=${String(xF).padStart(5)} | LEGAL=${String(lF).padStart(5)} | 告警=${warnings.length}`);
  return { ...st, xF, lF, w: warnings.length };
}

const g1 = await scenario({ label: "G1 合法标记 + 陈旧标记（一次性写�?撤销形状�?, oneShotWrite: true });
check2(g1.exit === "cap", `注释主张"出口必然=cap"：实测出�?${g1.exit}`);
check2(g1.xF === false, "G1：陈旧标记已治好");
check2(g1.lF === true, "G1：合法标记被保留");
check2(g1.w === 0, "G1：零告警");

const g2 = await scenario({ label: "G2 合法标记 + 陈旧标记（无写入方）", oneShotWrite: false });
check2(g2.exit === "cap", `注释主张"出口必然=cap"：实测出�?${g2.exit}`);
check2(g2.xF === false, "G2：陈旧标记已治好");
check2(g2.w === 0, "G2：零告警");

// G3：只有合法标记（无任何陈旧标记）
warnings.length = 0;
seed({ flowNodes: [mk(X, false), mk(L, false)], jobs: [job("jL", L, "queued")] });
await sleepMs(10);
reset();
useFlowStore.setState({ nodes: [mk(X, false), mk(L, true)] });
const g3 = { passes: globalThis.__R7_PASSES__, exit: globalThis.__R8_EXIT__ };
console.log(`${"G3 只有合法标记（无陈旧标记�?.padEnd(46)} | 轮数=${String(g3.passes).padStart(3)} | 出口=${String(g3.exit).padStart(9)} | 告警=${warnings.length}`);
check2(g3.exit === "cap", `"必然 cap" 在只有合法标记时：实测出�?${g3.exit}`);

console.warn = origWarn;
console.log("");
console.log(`RESULT: ${bad === 0 ? "新注释的必然性主张成�? : `新注释的必然性主张被 ${bad} 条实测反例否证`}`);
process.exitCode = bad === 0 ? 0 : 1;
