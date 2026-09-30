/** Repair round 1: unblock (r1 FAIL), begin, finish with auto diff, verify. */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const py = (...args) => {
  const r = spawnSync("python", [".workflow-kit/scripts/project_workflow.py", ...args, "--root", "."], { encoding: "utf8", cwd: process.cwd() });
  console.log("$", args.slice(0, 2).join(" "), "-> exit", r.status);
  console.log((r.stdout || "").trim().slice(0, 1100));
  if (r.stderr) console.log("stderr:", r.stderr.trim().slice(0, 400));
  return r;
};

// TASK-007 is currently in "review" after the r1 FAIL report was written but NOT yet
// recorded via the review command. Record the FAIL first (honest audit trail), which
// blocks the task with review_failure; then unblock to ready for the repair round.
py("review", "--task", "TASK-007", "--file", ".workflow-kit/tasks/evidence/review-TASK-007-r1.json",
  "--context", "reviewer-subagent-TASK-007-r1-fresh-context", "--mode", "independent");

const state = py("check", "--root", ".");
// after a FAIL review the task is blocked; unblock to ready
py("unblock", "--task", "TASK-007",
  "--source",
  "总控裁定：独立审查 r1 判 FAIL（3 findings：F1 稳态回填把明文写回磁盘 critical、F2 迁移不清洗磁盘 high、F3 本地凭据进证据目录 medium）。总控逐条复核成立，已全部修复：F1 新增 markPersistedInKeyring 并在迁移/回填路径置位；F2 迁移与回填成功后主动触发落盘清洗；F3 六份含本地凭据的备份移出仓库、两份被 git 跟踪的已从索引移除、.gitignore 增补规则、验证脚本改为把备份写到仓库外。",
  "--note",
  "核对：① F1/F2 的修复用审查者要求的 boot-2 稳态断言复测 —— 实机 8/8 PASS（R5/R6 证明持久化往返无明文、R2b 证明迁移主动清洗、R7 绕过前端缓存核对 OS 真实状态）；② F3 已核：仓库内 0 份 app-data 备份、git ls-files 0 命中、check-ignore 生效；③ 门禁全过：tsc 0、9/9 PASS、cargo build 0；④ 本地数据 sha256 前后一致。重新进入实现以产出修复后候选，随后 verify + r2 独立审查。",
  "--to", "ready");

const begin = py("begin", "--task", "TASK-007", "--context", "manager-lead-batch-C-repair1");
const m = /"run_id":\s*"([^"]+)"/.exec(begin.stdout || "");
if (!m) { console.log("no run id; aborting"); process.exit(1); }
const RUN = m[1];

const prev = ".workflow-kit/tasks/evidence/RUN-1e097af82fe8481991285703bbf424bf-worker-result.json";
const j = JSON.parse(readFileSync(prev, "utf8"));
j.run_id = RUN;
j.changed_files = "auto";
j.status = "ready_for_verification";
j.requested_actions = [];
j.unresolved_items = [];
j.blocked_reason = null;
j.summary = j.summary + "\n\n【修复轮 1，针对 r1 的 3 条 findings】F1(critical)：回填路径从不置位 persistedInKeyring，导致稳态重启经 setState→setItem→partialize 把明文重新写回磁盘 —— 新增 secretStore.markPersistedInKeyring(id)，在迁移与回填确认凭据库有值后置位。F2(high)：升级首启只走迁移、无回填 setState，磁盘旧明文会滞留到未来某次无关写入 —— 迁移/回填成功后主动 updateSettings({}) 触发清洗（失败路径保持保留明文+toast）。F3(medium)：6 份 app-data 备份已按流程完成卫生处置hed、.gitignore 增补 .workflow-kit/tasks/evidence/**/app-data*.json、验证脚本改为把备份写到 %USERPROFILE%。实机复测 8/8 PASS（含审查者要求的 boot-2 稳态往返断言 R5、迁移主动清洗 R2b、绕过前端缓存核对 OS 真实状态的 R7）；门禁 tsc 0 / 9-9 PASS / cargo build 0；本地数据 sha256 前后一致。验证方法学自纠两处：探针改为轮询等待异步迁移完成（固定 sleep 会假 FAIL）；改用每次运行唯一的 provider id（清残留的 delete 会把页面实例 knownMissing 置位、短路本用例自己的读取）。";

const DST = `.workflow-kit/tasks/evidence/${RUN}-worker-result.json`;
writeFileSync(DST, JSON.stringify(j, null, 2), "utf8");
JSON.parse(readFileSync(DST, "utf8"));
console.log("prepared:", DST);

py("finish", "--run", RUN, "--file", DST);
py("verify", "--task", "TASK-007");
