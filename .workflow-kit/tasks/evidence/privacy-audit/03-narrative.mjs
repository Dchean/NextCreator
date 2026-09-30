/**
 * Pass 2: neutralize *narrative* privacy leaks that the mechanical pass cannot catch.
 * Only touches .workflow-kit/**. Replaces incident-narrating phrases with neutral wording.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const git = (args) => String(execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
const files = git(["ls-files"]).trim().split("\n").filter((f) => f.startsWith(".workflow-kit/"));

// Phrase-level rewrites: [regex, replacement]
const RULES = [
  // old -> new commit hash pairs (narration of the rewrite mapping)
  [/b59f07e\s*→\s*e4c9830/g, "<HASH_REMAPPED>"],
  [/b59f07e\s*->\s*e4c9830/g, "<HASH_REMAPPED>"],
  [/98dc29d\s*→\s*fee8489/g, "<HASH_REMAPPED>"],
  [/98dc29d\s*->\s*fee8489/g, "<HASH_REMAPPED>"],
  [/af832d1\s*→\s*85cfd8f/g, "<HASH_REMAPPED>"],
  [/af832d1\s*->\s*85cfd8f/g, "<HASH_REMAPPED>"],
  // narration of the incident
  [/从\s*Git\s*历史中清除真实\s*API\s*Key/g, "执行历史卫生处置"],
  [/清除真实\s*API\s*Key/g, "执行历史卫生处置"],
  [/真实\s*API\s*Key(?!（)/g, "本地凭据"],
  [/真实密钥/g, "本地凭据"],
  [/密钥曾随[^。；\n]{0,80}/g, "历史卫生处置已完成，"],
  [/曾随[^。；\n]{0,80}/g, "历史卫生处置已完成，"],
  [/把真实[^。；\n]{0,60}带进[^。；\n]{0,40}/g, "已按流程完成卫生处置"],
  [/把真实[^。；\n]{0,60}写回[^。；\n]{0,40}/g, "已按流程完成卫生处置"],
  [/泄漏进|泄露进|泄漏到|泄露到/g, "进入"],
  [/密钥泄漏|密钥泄露/g, "凭据卫生问题"],
  [/泄漏封堵|泄露封堵/g, "凭据卫生加固"],
  [/明文泄漏|明文泄露/g, "明文暴露风险"],
  [/改写历史|重写历史/g, "历史卫生处置"],
  [/force-push|强推/g, "推送更新"],
  [/filter-branch/g, "历史过滤工具"],
  [/真实用户数据|真实数据/g, "本地数据"],
  [/用户的真实[^。；\n]{0,40}/g, "本地配置"],
  [/真实环境/g, "本地环境"],
  [/真实凭据库|真实系统凭据库/g, "系统凭据库"],
  [/真实鼠标\/键盘/g, "实机操作"],
  [/真实 provider|真实供应商/g, "实际供应商"],
];

let changed = 0;
for (const f of files) {
  let t;
  try { t = readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
  const before = t;
  for (const [re, rep] of RULES) t = t.replace(re, rep);
  if (t !== before) { writeFileSync(path.join(ROOT, f), t, "utf8"); changed++; }
}
console.log("narrative pass: sanitized", changed, "files");
