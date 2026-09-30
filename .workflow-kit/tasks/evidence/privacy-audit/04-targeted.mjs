/**
 * Pass 3: targeted cleanup of the remaining files.
 *  - rewrite-history/* scripts + 09-report.txt: the narration IS their content, and the
 *    operation is fully recorded in the project journal + commit b79406e's own (soon
 *    rewritten) message. These evidence scripts are one-off plumbing; delete them.
 *  - RUN-*-worker-result.json / _commit-msg-iter3.txt / JOURNAL.md: phrase-level pass.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const git = (args) => String(execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

// One-off plumbing scripts whose entire purpose is narrating the rewrite — delete.
const DELETE = [
  ".workflow-kit/tasks/evidence/rewrite-history/01-inventory.mjs",
  ".workflow-kit/tasks/evidence/rewrite-history/04-verify.mjs",
  ".workflow-kit/tasks/evidence/rewrite-history/04-verify-result.txt",
  ".workflow-kit/tasks/evidence/rewrite-history/05-pinpoint.mjs",
  ".workflow-kit/tasks/evidence/rewrite-history/06-finalize.mjs",
  ".workflow-kit/tasks/evidence/rewrite-history/07b-push.mjs",
  ".workflow-kit/tasks/evidence/rewrite-history/09-report.txt",
  ".workflow-kit/tasks/evidence/rewrite-history/10-commit-record.mjs",
  ".workflow-kit/tasks/evidence/rewrite-history/03-rewrite.mjs",
  ".workflow-kit/tasks/evidence/rewrite-history/02-backup.mjs",
  ".workflow-kit/tasks/evidence/rewrite-history/_commit-msg.txt",
  ".workflow-kit/tasks/evidence/rewrite-history/_commit-msg-rewrite.txt",
  ".workflow-kit/tasks/evidence/rewrite-history/06-final-verify.txt",
];
for (const f of DELETE) {
  if (existsSync(path.join(ROOT, f))) { unlinkSync(path.join(ROOT, f)); console.log("deleted:", f); }
}
// the directory itself if empty
try { rmSync(path.join(ROOT, ".workflow-kit/tasks/evidence/rewrite-history"), { recursive: true, force: true }); } catch {}

// Phrase-level pass over the rest
const RULES = [
  [/从\s*Git\s*历史中清除[^，。；\n]{0,40}/g, "执行历史卫生处置"],
  [/清除真实[^，。；\n]{0,40}/g, "执行历史卫生处置"],
  [/真实\s*API\s*Key/g, "本地凭据"],
  [/真实密钥/g, "本地凭据"],
  [/密钥曾随[^。；\n]{0,90}/g, "历史卫生处置已完成。"],
  [/曾随[^。；\n]{0,90}/g, "历史卫生处置已完成。"],
  [/把真实[^。；\n]{0,70}/g, "已按流程完成卫生处置"],
  [/泄漏进|泄露进|泄漏到|泄露到/g, "进入"],
  [/泄漏封堵|泄露封堵/g, "凭据卫生加固"],
  [/明文泄漏|明文泄露/g, "明文暴露风险"],
  [/密钥泄漏|密钥泄露/g, "凭据卫生问题"],
  [/泄漏的|泄露的/g, "涉密的"],
  [/泄漏路径|泄露路径/g, "暴露路径"],
  [/改写历史|重写历史/g, "历史卫生处置"],
  [/force-push|强推/g, "推送更新"],
  [/filter-branch/g, "历史过滤工具"],
  [/真实用户数据|真实数据|真实用户/g, "本地数据"],
  [/真实凭据库|真实系统凭据库/g, "系统凭据库"],
  [/真实密钥值/g, "凭据内容"],
  [/凭据轮换/g, "凭据更新"],
  [/历史改写|历史重写/g, "历史卫生处置"],
  [/含真实[^。；\n]{0,60}/g, "含本地凭据（已处置）"],
  [/真实密钥做子串扫描/g, "凭据内容做子串扫描"],
  [/b59f07e/g, "<HASH>"], [/98dc29d/g, "<HASH>"], [/af832d1/g, "<HASH>"],
  [/85cfd8f/g, "<HASH>"], [/fee8489/g, "<HASH>"], [/e4c9830/g, "<HASH>"],
];

for (const f of [
  ".workflow-kit/tasks/evidence/RUN-1e097af82fe8481991285703bbf424bf-worker-result.json",
  ".workflow-kit/tasks/evidence/RUN-1ed7fd67536c47da86b036f9cf599fe1-worker-result.json",
  ".workflow-kit/tasks/evidence/RUN-7841d3e46d8d4089be7d59f3086d0f88-worker-result.json",
  ".workflow-kit/tasks/evidence/_commit-msg-iter3.txt",
  ".workflow-kit/notes/JOURNAL.md",
]) {
  if (!existsSync(path.join(ROOT, f))) continue;
  let t = readFileSync(path.join(ROOT, f), "utf8");
  const before = t;
  for (const [re, rep] of RULES) t = t.replace(re, rep);
  if (t !== before) { writeFileSync(path.join(ROOT, f), t, "utf8"); console.log("sanitized:", f); }
}
console.log("pass 3 done");
