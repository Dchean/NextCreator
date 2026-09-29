// 审查探头：把 r7-cap-armN.mjs 改造成 N=1..7 的“误报是否消失 + 出口分支”核查（只写 %TEMP%）
import { readFileSync, writeFileSync } from "node:fs";
const SRC = new URL("./r7-cap-armN.mjs", import.meta.url);
const DST = new URL("./r8-armN.mjs", import.meta.url);
let s = readFileSync(SRC, "utf8");
const pairs = [
  [
    `  s = s.replace("      passes += 1;", "      passes += 1; globalThis.__R7_PASSES__ = passes;");`,
    `  s = s.replace("      passes += 1;", "      passes += 1; globalThis.__R7_PASSES__ = passes;");
  s = s.replace("      if (!healPending) break;", "      if (!healPending) { globalThis.__R8_EXIT__ = 'nopending'; break; }");
  s = s.replace("      if (candidates.length === 0) break;", "      if (candidates.length === 0) { globalThis.__R8_EXIT__ = 'zero'; break; }");
  s = s.replace("      if (passes >= MAX_HEAL_PASSES) {", "      if (passes >= MAX_HEAL_PASSES) { globalThis.__R8_EXIT__ = 'cap';");`,
  ],
  [
    "  if (nPass !== 1 || nPred !== 1) throw new Error(`插桩锚点计数异常 pass=${nPass} pred=${nPred}，探针失效`);",
    "  const nExit = (s.match(/__R8_EXIT__ = '/g) || []).length;\n  if (nPass !== 1 || nPred !== 1 || nExit !== 3) throw new Error(`插桩锚点计数异常 pass=${nPass} pred=${nPred} exit=${nExit}，探针失效`);",
  ],
  [
    "const reset = () => { globalThis.__R7_PASSES__ = 0; globalThis.__R7_PRED__ = 0; };",
    "const reset = () => { globalThis.__R7_PASSES__ = 0; globalThis.__R7_PRED__ = 0; globalThis.__R8_EXIT__ = undefined; };",
  ],
  ["  for (const ARM of [9, 12]) {", "  for (const ARM of [1, 2, 5, 6, 7, 8, 9, 12]) {"],
  [
    "`  补 ${ARM} 次的有界写入方：轮数=${passes} 警告数=${warnsAtReturn} 最终标记=",
    "`  补 ${ARM} 次的有界写入方：轮数=${passes} 警告数=${warnsAtReturn} 出口=${globalThis.__R8_EXIT__} 最终标记=",
  ],
  [
    "    check(!(healed && warnsAtReturn > 0) || QS === NOCAP,",
    `    if (QS === NOCAP) continue;
    const expWarn = ARM >= 8 ? 1 : 0;
    const expPasses = ARM >= 8 ? 8 : ARM + 1;
    check(
      warnsAtReturn === expWarn && healed === (ARM <= 7) && passes === expPasses &&
        globalThis.__R8_EXIT__ === (ARM >= 8 ? "cap" : "zero"),
      \`补 \${ARM} 次：期望 轮数=\${expPasses} 警告=\${expWarn} 出口=\${ARM >= 8 ? "cap" : "zero"} 治愈=\${ARM <= 7}\` +`,
  ],
];
for (const [from, to] of pairs) {
  if (!s.includes(from)) throw new Error(`补丁锚点未命中：${from.slice(0, 60)}`);
  s = s.replace(from, to);
}
writeFileSync(DST, s, "utf8");
console.log("written r8-armN.mjs");
