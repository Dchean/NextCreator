/** Record the history-rewrite report + commit the rewrite scripts as a final commit. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "D:\\NextCreator";
const git = (args) => String(execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

// 1) record the disposition in the project journal
const note = readFileSync(".workflow-kit/tasks/evidence/rewrite-history/09-report.txt", "utf8");
const n = spawnSync("python", [
  ".workflow-kit/scripts/project_workflow.py", "note",
  "--kind", "decision",
  "--text", note, "--root", ".",
], { encoding: "utf8", cwd: ROOT });
console.log("note exit:", n.status, (n.stdout || "").trim().slice(0, 200));
if (n.stderr) console.log("note stderr:", n.stderr.trim().slice(0, 300));

// 2) commit the rewrite record (the scripts + report), then push
const msg = [
  "chore(security): 从 Git 历史中清除真实 API Key（用户授权改写历史）",
  "",
  "密钥曾随 task003-live / live-acceptance-20260929 两份证据备份进入 v0.2.8~v0.2.10 的历史",
  "并被推送到 NextCreator 远端。经用户授权，用 filter-branch --index-filter 从全部历史移除",
  "这两个路径，重写 v0.2.8/v0.2.9/v0.2.10 等 16 个 tag，force-push main，",
  "并从 GitHub 重新克隆逐提交扫描确认 0 命中。完整记录见 09-report.txt，",
  "回滚备份在 C:/Users/A/NextCreator-key-backups/pre-rewrite/。",
  "",
  "改写前后的哈希对照：",
  "  v0.2.8  b59f07e -> e4c9830",
  "  v0.2.9  98dc29d -> fee8489",
  "  v0.2.10 af832d1 -> 85cfd8f",
].join("\n");
writeFileSync(".workflow-kit/tasks/evidence/rewrite-history/_commit-msg-rewrite.txt", msg, "utf8");
git(["add", "-A"]);
git(["-c", "core.safecrlf=false", "commit", "-q", "-F", ".workflow-kit/tasks/evidence/rewrite-history/_commit-msg-rewrite.txt"]);
console.log("commit:", git(["log", "--oneline", "-1"]).trim());
git(["push", "-q", "NextCreator", "refs/heads/main:refs/heads/main"]);
console.log("pushed");
console.log("remote main:", git(["ls-remote", "NextCreator", "refs/heads/main"]).trim().split("\t")[0]);
console.log("local  main:", git(["rev-parse", "HEAD"]).trim());
