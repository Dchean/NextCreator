// 诊断：统计损坏文件里 U+FFFD 的位置与上下文（只读，不修改仓库文件）
import { readFileSync } from "node:fs";

const p = "D:/NextCreator/scripts/.recovered-queue-regression.mjs";
const s = readFileSync(p, "utf8");
const chars = [...s];
const bad = [];
chars.forEach((c, i) => {
  if (c === "\uFFFD") bad.push(i);
});
console.log("total chars:", chars.length);
console.log("U+FFFD count:", bad.length);

// 看每个坏点前后各 12 个字符，判断被吞掉的是什么
for (const i of bad.slice(0, 40)) {
  const before = chars.slice(Math.max(0, i - 14), i).join("").replace(/\n/g, "\\n");
  const after = chars.slice(i + 1, i + 15).join("").replace(/\n/g, "\\n");
  const codes = [...s.slice(Math.max(0, i - 2), i + 3)].map((c) => c.codePointAt(0).toString(16)).join(",");
  console.log(`@${i} [${codes}] ...${before} <BAD> ${after}...`);
}
if (bad.length > 40) console.log(`... 其余 ${bad.length - 40} 个省略`);

// 关键校验：把 U+FFFD 换成换行后，行数是否变得合理、ASCII 结构是否完整
const repaired = s.replace(/\uFFFD/g, "\n");
console.log("lines before repair:", s.split("\n").length);
console.log("lines after repair:", repaired.split("\n").length);
