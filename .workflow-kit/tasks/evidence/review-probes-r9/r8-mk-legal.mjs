// 生成 R8 合法标记探针：复用 r7-cap-armN.mjs 的前 125 行（loader + helpers），追加自有用例
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const lines = readFileSync(path.join(dir, "r7-cap-armN.mjs"), "utf8").split(/\r?\n/);
// 找到 `let failures = 0;` 之前的位置作为 preamble 边界
const cut = lines.findIndex((l) => l.startsWith("console.log(`模块来源"));
if (cut < 120) throw new Error(`preamble 边界异常：${cut}`);
const preamble = lines.slice(0, cut).join("\n");
for (const need of ["const stubs", "registerHooks", "useQueueStore", "const seed =", "function seed", "const mk =", "const job =", "const canvasMarker", "const reset ="]) {
  // 只做存在性提示，不强制
}
const body = `
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const LEGAL = "gen-legal";
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(" ")); };
console.log("场景：LEGAL=合法标记（真有 queued 任务，谓词永不清它）；X=陈旧标记（写入方补 ARM 次即停）");
console.log("ARM | 轮数 | 出口      | X 最终 | 警告数 | :979「仍有陈旧标记未复核」是否成立");
let suspect = 0;
for (const ARM of [1, 2, 3, 5, 6, 7, 8]) {
  warnings.length = 0;
  seed({ flowNodes: [mk(X, false), mk(LEGAL, false)], jobs: [job("jL", LEGAL, "queued")] });
  await sleepMs(15);
  reset();
  warnings.length = 0;
  let wWrites = 0;
  const unsubW = useFlowStore.subscribe(() => {
    const xTrue = useFlowStore.getState().nodes.find((n) => n.id === X)?.data?.queued === true;
    if (xTrue) return;
    wWrites++;
    if (wWrites > ARM) return;
    useFlowStore.setState({ nodes: useFlowStore.getState().nodes.map((n) => (n.id === X ? { ...n, data: { ...n.data, queued: true } } : n)) });
  });
  useFlowStore.setState({ nodes: [mk(X, true), mk(LEGAL, true)] });
  const passes = globalThis.__R7_PASSES__;
  const exit = globalThis.__R8_EXIT__;
  const warns = warnings.length;
  const xFinal = marker(X);
  const legalFinal = marker(LEGAL);
  await sleepMs(20);
  unsubW();
  const claimHolds = xFinal === true;
  if (!claimHolds && warns > 0) suspect++;
  console.log(
    \`\${String(ARM).padStart(3)} | \${String(passes).padStart(4)} | \${String(exit).padStart(9)} | \${String(xFinal).padStart(6)} | \${String(warns).padStart(6)} | \${claimHolds ? "成立" : "★ 不成立：X 已治愈，剩余候选只有合法标记"}  (LEGAL=\${legalFinal}, W写入=\${wWrites})\`
  );
}
console.warn = origWarn;
console.log("");
console.log(\`RESULT: \${suspect === 0 ? "上限告警措辞在所有臂上均成立" : \`★ \${suspect} 个臂上发出误报警告（X 已治愈却称未复核）\`}\`);
process.exitCode = suspect === 0 ? 0 : 1;
`;
writeFileSync(path.join(dir, "r8-legal-marker-warn.mjs"), preamble + "\n" + body, "utf8");
console.log("written r8-legal-marker-warn.mjs (preamble lines:", cut, ")");
