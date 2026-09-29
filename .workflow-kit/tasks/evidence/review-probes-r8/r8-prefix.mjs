// 构造“前缀版”突变体：把上限检查块移回零候选重扫之前（round 7 声称的旧顺序），验证误报是否真实存在
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const REAL = "D:\\NextCreator\\src\\stores\\queueStore.ts";
const TMP = path.join(process.env.TEMP, "r7review");
mkdirSync(TMP, { recursive: true });
let s = readFileSync(REAL, "utf8").replace(/\r\n/g, "\n");

// 提取上限检查块（从 `if (passes >= MAX_HEAL_PASSES) {` 到该块结束的 `}`）
const capStart = s.indexOf("      if (passes >= MAX_HEAL_PASSES) {");
if (capStart < 0) throw new Error("cap block anchor missing");
const endMarker = "\n      }\n    }\n  } finally {";
const capEnd = s.indexOf(endMarker, capStart);
if (capEnd < 0) throw new Error("cap block end anchor missing");
const capBlock = s.slice(capStart, capEnd + 8); // 含结尾 "      }\n"
let rest = s.slice(0, capStart) + s.slice(capStart + capBlock.length);

// 把 cap 块插到 `healPending = false;` 之后（即重扫之前）——这就是被修正前的顺序
const anchor = "      healPending = false;\n";
const at = rest.indexOf(anchor);
if (at < 0) throw new Error("healPending anchor missing");
rest = rest.slice(0, at + anchor.length) + capBlock + rest.slice(at + anchor.length);

// 校验：cap 检查行号必须先于零候选重扫行号
const iCap = rest.indexOf("if (passes >= MAX_HEAL_PASSES)");
const iZero = rest.indexOf("if (candidates.length === 0) break;");
if (!(iCap > 0 && iZero > 0 && iCap < iZero)) throw new Error(`顺序未变：cap=${iCap} zero=${iZero}`);
writeFileSync(path.join(TMP, "qs-prefix.ts"), rest, "utf8");
console.log(`prefix mutant written: cap@${iCap} < zero@${iZero}  (cap block ${capBlock.split("\n").length} lines moved)`);
