/**
 * 审查者工具：比较 REQ-004 行为矩阵的 before / candidate 两份探针输出。
 * 用法：node compare-req004.mjs <before.json> <candidate.json> <out.md>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [beforePath, candPath, outPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const cand = JSON.parse(readFileSync(candPath, "utf8"));

const keys = [...new Set([...Object.keys(before.results), ...Object.keys(cand.results)])].sort();
const lines = [];
lines.push("# REQ-004 行为矩阵：改动前（HEAD）vs 候选（工作区）");
lines.push("");
lines.push(`- before 源码根: ${before.root}`);
lines.push(`- candidate 源码根: ${cand.root}`);
lines.push("- 驱动层：nodeExecutor.executeNode（本次改动的那一层），provider/fileStorage 用同一组替身");
lines.push("");
lines.push("| 场景 | before: result | candidate: result | before: node.status | candidate: node.status | 差异 |");
lines.push("|---|---|---|---|---|---|");
let diffs = 0;
for (const k of keys) {
  const b = before.results[k];
  const c = cand.results[k];
  const fmtResult = (v) =>
    v && v.result ? `success=${v.result.success}${v.result.error ? ` err=${JSON.stringify(v.result.error)}` : ""}` : JSON.stringify(v);
  const bR = fmtResult(b);
  const cR = fmtResult(c);
  const bS = b && b.node ? JSON.stringify(b.node.status) : "-";
  const cS = c && c.node ? JSON.stringify(c.node.status) : "-";
  const same = bR === cR && bS === cS;
  if (!same) diffs += 1;
  lines.push(`| ${k} | ${bR} | ${cR} | ${bS} | ${cS} | ${same ? "无" : "**有**"} |`);
}
lines.push("");
lines.push(`共 ${keys.length} 个场景，其中 result 或 node.status 有差异的 ${diffs} 个。`);
lines.push("");
lines.push("## 逐场景完整节点字段（只列有差异的场景）");
for (const k of keys) {
  const b = before.results[k];
  const c = cand.results[k];
  const bj = JSON.stringify(b && b.node);
  const cj = JSON.stringify(c && c.node);
  if (bj === cj && JSON.stringify(b && b.result) === JSON.stringify(c && c.result)) continue;
  lines.push("");
  lines.push(`### ${k}`);
  lines.push("```json");
  lines.push(`before    = ${JSON.stringify(b, null, 2)}`);
  lines.push(`candidate = ${JSON.stringify(c, null, 2)}`);
  lines.push("```");
}
writeFileSync(outPath, lines.join("\n"), "utf8");
console.log(lines.slice(0, 40).join("\n"));
console.log(`\nwrote ${outPath}`);
