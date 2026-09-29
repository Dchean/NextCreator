/** Read the r2 review report with tolerant parsing. */
import { readFileSync } from "node:fs";

const P = ".workflow-kit/tasks/evidence/review-TASK-007-r2.json";
let t = readFileSync(P, "utf8");

// 1) strict parse first
let j = null;
try {
  j = JSON.parse(t);
  console.log("STRICT JSON: valid");
} catch (e) {
  console.log("STRICT JSON: INVALID ->", e.message);
}

if (j) {
  console.log("verdict:", j.verdict, "| findings:", (j.findings || []).length);
  console.log("candidate:", j.candidate_digest);
  console.log("verification_run:", j.verification_run);
  console.log("checks:", j.review_checks.map((c) => c.area + "=" + c.status).join(" "));
  console.log("\nSUMMARY:\n" + j.summary.slice(0, 2400));
  if ((j.findings || []).length) {
    console.log("\nFINDINGS:");
    for (const f of j.findings) console.log("-", typeof f === "string" ? f : JSON.stringify(f).slice(0, 900));
  }
} else {
  const vm = t.match(/"verdict":\s*"(\w+)"/);
  console.log("verdict(raw):", vm && vm[1]);
  const statuses = [...t.matchAll(/"area":\s*"(\w+)",\s*"status":\s*"(\w+)"/g)].map((m) => `${m[1]}=${m[2]}`);
  console.log("checks(raw):", statuses.join(" "));
  const fi = t.indexOf('"findings"');
  const rc = t.indexOf('"review_checks"');
  console.log("\nFINDINGS RAW:\n" + t.slice(fi, rc).slice(0, 4000));
}
