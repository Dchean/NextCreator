import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
const packet = JSON.parse(readFileSync(".workflow-kit/tasks/evidence/review-packet-TASK-007-r2.json", "utf8"));
const files = packet.task_packet.candidate_files;
let mismatch = 0, missing = 0;
const bad = [];
for (const f of files) {
  if (!existsSync(f.path)) { missing++; bad.push({ path: f.path, why: "MISSING" }); continue; }
  const h = createHash("sha256").update(readFileSync(f.path)).digest("hex");
  if (h !== f.sha256) { mismatch++; bad.push({ path: f.path, expected: f.sha256, actual: h }); }
}
console.log(JSON.stringify({ total: files.length, mismatch, missing, bad }, null, 2));
// recompute candidate_digest with the tool's algorithm: json.dumps(sort_keys, compact) of [{path,sha256}]
const canon = JSON.stringify(files.map(f => ({ path: f.path, sha256: f.sha256 })));
console.log("recomputed candidate_digest:", createHash("sha256").update(canon).digest("hex"));
console.log("binding digest          :", packet.task_packet.candidate_digest);
