// 核实注释 :975「跑满探针硬闸 401 轮」：把探针硬闸设为 400，观察 Infinity 突变体的轮数
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const src = path.join(dir, "r7-cap-armN.mjs");
const dst = path.join(dir, "r8-cap-hard400.mjs");
let s = readFileSync(src, "utf8");
const from = "const HARD = 200; // 探针自保闸";
if (!s.includes(from)) throw new Error("HARD 锚点未命中");
s = s.replace(from, "const HARD = 400; // 探针自保闸");
writeFileSync(dst, s, "utf8");
console.log("written r8-cap-hard400.mjs");
