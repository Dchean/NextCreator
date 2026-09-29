// 给已生成的前缀突变体插桩（passes / 三个出口），并自校验锚点命中数
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
const TMP = path.join(process.env.TEMP, "r7review");
const SRC = path.join(TMP, "qs-prefix.ts");
const DST = path.join(TMP, "qs-prefix-inst.ts");
if (!existsSync(SRC)) throw new Error("先运行 r8-prefix.mjs");
let s = readFileSync(SRC, "utf8");
const subs = [
  ["      passes += 1;", "      passes += 1; globalThis.__R7_PASSES__ = passes;"],
  ["      if (!healPending) break;", "      if (!healPending) { globalThis.__R8_EXIT__ = 'nopending'; break; }"],
  ["      if (candidates.length === 0) break;", "      if (candidates.length === 0) { globalThis.__R8_EXIT__ = 'zero'; break; }"],
  ["      if (passes >= MAX_HEAL_PASSES) {", "      if (passes >= MAX_HEAL_PASSES) { globalThis.__R8_EXIT__ = 'cap';"],
];
const counts = {};
for (const [from, to] of subs) {
  const n = s.split(from).length - 1;
  counts[from.trim()] = n;
  if (n !== 1) throw new Error(`锚点 ${from.trim()} 命中 ${n} 次，应恰好 1 次`);
  s = s.replace(from, to);
}
// 语法自检：用 Function 构造器粗查（TS 类型标注会失败，故只做括号平衡检查）
const bal = [...s].reduce((a, c) => a + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);
if (bal !== 0) throw new Error(`花括号不平衡：${bal}`);
writeFileSync(DST, s, "utf8");
// 顺序复核：cap 必须先于 zero
const iCap = s.indexOf("if (passes >= MAX_HEAL_PASSES)");
const iZero = s.indexOf("if (candidates.length === 0) {");
console.log(`OK 插桩完成 → ${DST}`);
console.log(`   锚点命中：${JSON.stringify(counts)}`);
console.log(`   顺序：cap@${iCap} < zero@${iZero} → ${iCap < iZero ? "前缀顺序（旧）" : "修正后顺序"}`);
