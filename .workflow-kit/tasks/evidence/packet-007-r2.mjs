/** Generate the r2 review packet for TASK-007's repaired candidate. */
import { spawnSync } from "node:child_process";

const r = spawnSync("python", [
  ".workflow-kit/scripts/project_workflow.py", "review-packet",
  "--task", "TASK-007", "--root", ".",
], { encoding: "utf8", cwd: process.cwd() });
// Write stdout (JSON) to file with BOM stripped
let out = r.stdout || "";
if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
const fs = await import("node:fs");
fs.writeFileSync(".workflow-kit/tasks/evidence/review-packet-TASK-007-r2.json", out, "utf8");
const j = JSON.parse(out);
console.log("candidate:", j.task_packet.candidate_digest);
console.log("verification:", j.task_packet.verification.id, j.task_packet.verification.outcome, "exit", j.task_packet.verification.exit_code);
console.log("checks:", j.task_packet.verification.checks.map((c) => c.gate_id + "=" + c.status).join(" "));
console.log("candidate_files:", j.task_packet.candidate_files.length);
console.log("risk:", j.task_packet.task.risk.level, "| mode:", j.task_packet.required_review_mode);
