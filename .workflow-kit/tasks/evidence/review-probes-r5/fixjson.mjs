import { readFileSync, writeFileSync } from "node:fs";
const p = process.argv[2];
const o = JSON.parse(readFileSync(p, "utf8"));
const allowed = /^(src\/stores\/queueStore\.ts|src\/hooks\/useImageGeneratorExecution\.ts|src\/services\/imageGenerationExecution\.ts|src\/components\/nodes\/ImageGeneratorNode\.tsx|src\/utils\/tauriStorage\.ts|scripts\/queue-regression\.mjs|package\.json|tsconfig\.json|\.workflow-kit\/tasks\/(evidence|runs)\/)/;
let removed = [];
for (const c of o.review_checks) {
  c.evidence_files = c.evidence_files.filter((f) => {
    const ok = allowed.test(f.replace(/\\/g, "/"));
    if (!ok) removed.push(`${c.area}: ${f}`);
    return ok;
  });
}
writeFileSync(p, JSON.stringify(o, null, 2), "utf8");
console.log("removed:", removed.length ? removed.join(" | ") : "(none)");
console.log("valid json: true; areas:", o.review_checks.map((c) => `${c.area}=${c.status}`).join(", "));
console.log("verdict:", o.verdict, "| findings:", o.findings.length, "| ui_review:", JSON.stringify(o.ui_review));
