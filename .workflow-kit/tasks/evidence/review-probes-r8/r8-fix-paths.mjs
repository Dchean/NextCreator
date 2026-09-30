// 修正审查报告里 9 条猜错的探针路径为实际路径
import { readFileSync, writeFileSync } from "node:fs";
const F = "<LOCAL_USER_DIR>\\AppData\\Local\\Temp\\dsh-XUvJ5R\\r8-review-result.json";
let s = readFileSync(F, "utf8");
const fix = [
  ["review-probes-r6/probe-r4-guard2.mjs", "review-probes-r4/probe-r4-guard2.mjs"],
  ["review-probes-r6/probe-batch-chain.mjs", "review-probes-r2/probe-batch-chain.mjs"],
  ["review-probes-r6/probe-req001-coldstart.mjs", "review-probes-r2/probe-req001-coldstart.mjs"],
  ["review-probes-r6/probe-cross-canvas.mjs", "review-probes-r2/probe-cross-canvas.mjs"],
  ["review-probes-r6/probe-cancel-abort-lock.mjs", "review-probes-r2/probe-cancel-abort-lock.mjs"],
  ["review-probes-r6/probe-reject-timeline.mjs", "review-probes-r2/probe-reject-timeline.mjs"],
  ["review-probes-r6/probe-reject-erases-marker.mjs", "review-probes-r2/probe-reject-erases-marker.mjs"],
  ["review-probes-r6/probe-r3-finally-churn.mjs", "review-probes-r3/probe-r3-finally-churn.mjs"],
  ["review-probes-r6/probe-lock-via-ui.mjs", "review-probes-r2/probe-lock-via-ui.mjs"],
  ["review-probes-r5/probe-r3-unified-scope-verify.mjs", "review-probes-r3fix/probe-r3-unified-scope-verify.mjs"],
];
for (const [a, b] of fix) {
  const n = s.split(a).length - 1;
  if (n === 0) { console.log("skip (not cited):", a); continue; }
  s = s.split(a).join(b);
  console.log(`fixed ${n}x: ${a} -> ${b}`);
}
// 校验 JSON 仍可解析
const j = JSON.parse(s);
console.log("parse OK; checks =", j.review_checks.length);
writeFileSync(F, s, "utf8");
