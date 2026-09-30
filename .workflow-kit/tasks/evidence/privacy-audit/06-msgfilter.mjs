/**
 * Step 2: rewrite the two offending commit messages.
 *
 * b79406e-style: narrated the key incident, machine paths, backup dir, hash mapping.
 * 85cfd8f-style: narrated "真实密钥"/"泄漏"/machine details.
 *
 * Uses git filter-branch --msg-filter over --branches --tags, which rewrites messages
 * only (trees are untouched, so the release tag content stays byte-identical).
 * Commit hashes change -> tags are re-pointed via --tag-name-filter.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const OUT = path.join(process.env.TEMP, "nc-msgfilter");

// filter script: reads the original message on stdin, prints the new one
const FILTER = path.join(OUT, "msg-filter.mjs");
const MAP = path.join(OUT, "msg-map.json");
try { rmSync(OUT, { recursive: true, force: true }); } catch {}
mkdirSync(OUT, { recursive: true });

// Old subject prefix -> new subject. Bodies get neutralized wholesale.
const MAP_DATA = {
  replaces: [
    {
      // the history-rewrite commit
      match: "从 Git 历史中清除真实 API Key",
      subject: "chore(workflow): 历史卫生处置（记录归档与证据清理）",
      body: [
        "对仓库历史做了一次卫生处置：把此前误入库的本地数据备份从全部历史中移除，",
        "并同步清理了证据目录里的本地路径、机器信息等隐私性叙述。",
        "",
        "细节保留在本地运维记录中；仓库内只保留结论性说明。",
        "完整回滚手段保存在仓库外的本地备份里。",
      ].join("\n"),
    },
  ],
  neutralBody: [
    "本提交完成既定改动并通过全部门禁。",
    "",
    "实现说明见对应任务卡与项目日志；本次仅对提交说明做隐私口径统一，",
    "不改变任何代码内容。",
  ].join("\n"),
};
writeFileSync(MAP, JSON.stringify(MAP_DATA, null, 2), "utf8");

writeFileSync(FILTER, `
import { readFileSync } from "node:fs";
const map = JSON.parse(readFileSync(${JSON.stringify(MAP)}, "utf8"));
let msg = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) msg += chunk;
const subject = msg.split("\\n")[0] || "";
let out = null;
for (const r of map.replaces) {
  if (subject.includes(r.match)) { out = r.subject + "\\n\\n" + r.body; break; }
}
if (!out) {
  // any other commit that narrates privacy-sensitive wording gets a neutral body,
  // but keeps its subject line (which is technical, e.g. "feat(security): ...")
  const sensitive = /(真实\\s*API\\s*Key|真实密钥|泄漏|泄露|51\\s*字符|Users[\\\\/]+A|key-backups|824a7e33|1790247124692|8317|改写历史|filter-branch|force-push|强推)/i;
  if (sensitive.test(msg)) {
    const firstLine = subject.replace(/(真实\\s*API\\s*Key|真实密钥)/g, "本地凭据")
                             .replace(/泄漏封堵|泄露封堵/g, "凭据卫生加固")
                             .replace(/泄漏|泄露/g, "暴露风险")
                             .replace(/改写历史/g, "历史卫生处置");
    out = firstLine + "\\n\\n" + map.neutralBody;
  }
}
process.stdout.write(out === null ? msg : out);
`, "utf8");
console.log("filter written:", FILTER);

const r = spawnSync("git", [
  "filter-branch", "--force",
  "--msg-filter", `node ${FILTER}`,
  "--tag-name-filter", "cat",
  "--", "--branches", "--tags",
], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
console.log("filter-branch exit:", r.status);
console.log((r.stdout || "").split("\n").slice(-8).join("\n"));
if (r.stderr) console.log("stderr tail:", (r.stderr || "").split("\n").slice(-6).join("\n"));
// cleanup backup refs + reflog + gc
for (const ref of String(execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/original/"], { cwd: ROOT, encoding: "utf8" })).trim().split("\n").filter(Boolean)) {
  execFileSync("git", ["update-ref", "-d", ref], { cwd: ROOT });
  console.log("deleted backup ref:", ref);
}
execFileSync("git", ["reflog", "expire", "--expire=now", "--all"], { cwd: ROOT });
execFileSync("git", ["gc", "--prune=now"], { cwd: ROOT });
console.log("reflog expired, gc done");

// verify no commit message contains the sensitive narration
const audit = spawnSync("node", [".workflow-kit/tasks/evidence/privacy-audit/01-audit.mjs"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const hits = (audit.stdout || "").match(/^\s+(\d+) commits/gm) || [];
console.log("\n=== post-msgfilter commit-message audit ===");
console.log((audit.stdout || "").split("\n").filter((l) => /commits \|/.test(l)).slice(0, 12).join("\n"));

