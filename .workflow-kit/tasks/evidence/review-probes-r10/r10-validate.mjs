import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync(process.env.TEMP + "/r10-review-result.json", "utf8"));
const allowed = ["requirements", "regression", "failure_paths", "maintainability", "performance"];
console.log("keys = " + Object.keys(j).join(","));
console.log("allowed_keys_ok = " + JSON.stringify(Object.keys(j).sort()) );
console.log("verdict = " + j.verdict + " | findings = " + j.findings.length + " | ui_review = " + j.ui_review);
console.log("digest_ok = " + (j.candidate_digest === "a0272c52bb47acfa2cfb8424bb65209bd0dd89e04f594b43b0e416b072c70805"));
console.log("run_ok = " + (j.verification_run === "RUN-abbaf27af8614605a132bc76cb7b4aae") + " | task = " + j.task_id);
for (const c of j.review_checks) {
  const ok = allowed.includes(c.area) && ["PASS", "FAIL", "NOT_RUN", "NOT_APPLICABLE"].includes(c.status) && typeof c.analysis === "string" && Array.isArray(c.evidence_files);
  console.log(`  ${ok ? "ok " : "BAD"} ${c.area}:${c.status} evidence=${c.evidence_files.length}`);
}
