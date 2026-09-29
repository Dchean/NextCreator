/** Record the TASK-007 repair note (file-based to survive shell encoding). */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const text = readFileSync(".workflow-kit/tasks/evidence/note-task007-repair1.txt", "utf8");
const r = spawnSync("python", [
  ".workflow-kit/scripts/project_workflow.py", "note",
  "--task", "TASK-007", "--kind", "progress",
  "--text", text, "--root", ".",
], { encoding: "utf8", cwd: process.cwd() });
console.log("exit:", r.status);
const o = (r.stdout || "").trim();
console.log(o ? o.slice(0, 400) : "(no stdout)");
if (r.stderr) console.log("stderr:", r.stderr.trim().slice(0, 300));
