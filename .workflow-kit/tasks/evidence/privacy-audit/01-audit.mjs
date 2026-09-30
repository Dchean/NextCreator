/**
 * Privacy audit over (a) every commit message in history and (b) every tracked file.
 * NEVER prints the real key — only pattern names, counts, commits and paths.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const git = (args) => String(execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));

// Pattern name -> regex. Ordered by sensitivity.
const PATTERNS = [
  ["incident-narration(真实密钥/真实API Key)", /真实\s*(API\s*Key|密钥)|真实\s*51|密钥曾|曾随|清除真实/gi],
  ["leak-narration(泄漏/泄露)", /(泄漏|泄露)(路径|进|到|已|了)/gi],
  ["history-rewrite(改写历史/filter-branch/force-push)", /(改写历史|filter-branch|force-push|强推|重写.*tag)/gi],
  ["key-length(51 字符)", /51\s*字符|51-char/gi],
  ["user-path(C:\\Users\\A)", /Users[\\\/]+A\b/gi],
  ["backup-dir(NextCreator-key-backups)", /NextCreator-key-backups/gi],
  ["userdata-sha(824a7e33)", /824a7e33/gi],
  ["provider-id(1790247124692)", /1790247124692/gi],
  ["gateway-url(127.0.0.1:8317)", /127\.0\.0\.1:8317/gi],
  ["old-hash-mapping(b59f07e/98dc29d/af832d1)", /b59f07e|98dc29d|af832d1/gi],
  ["sandbox-os-error-5", /os error 5/gi],
];

// ---------- (a) commit messages ----------
const log = git(["log", "--all", "--format=%H%x00%s%x00%b%x00--END--"]);
const blocks = log.split("--END--").map((s) => s.replace(/^\n/, "")).filter((s) => s.trim());
const msgHits = new Map(); // pattern -> Set(commit short hash)
for (const b of blocks) {
  const hash = (b.split("\0")[0] || "").slice(0, 10);
  for (const [name, re] of PATTERNS) {
    const m = b.match(re);
    if (m) {
      if (!msgHits.has(name)) msgHits.set(name, new Set());
      msgHits.get(name).add(hash);
    }
  }
}
console.log("=== (a) COMMIT MESSAGES with sensitive patterns ===");
for (const [name, re] of PATTERNS) {
  const set = msgHits.get(name);
  if (set && set.size) console.log(`  ${set.size} commits | ${name}`);
  else console.log(`  0 commits | ${name}`);
}
console.log("\n-- detail: commits per pattern (top patterns) --");
for (const [name] of PATTERNS.slice(0, 8)) {
  const set = msgHits.get(name);
  if (!set || !set.size) continue;
  console.log(`\n[${name}]`);
  for (const h of [...set].slice(0, 12)) {
    const subject = git(["log", "--format=%s", "-1", h]).trim().slice(0, 70);
    console.log(`   ${h}  ${subject}`);
  }
}

// ---------- (b) tracked files ----------
const files = git(["ls-files"]).trim().split("\n").filter(Boolean);
console.log(`\n=== (b) TRACKED FILES (${files.length}) with sensitive patterns ===`);
const fileHits = new Map(); // pattern -> [paths]
let scanned = 0;
for (const f of files) {
  let t;
  try { t = readFileSync(path.join(ROOT, f), "utf8"); scanned++; } catch { continue; }
  for (const [name, re] of PATTERNS) {
    if (re.test(t)) {
      if (!fileHits.has(name)) fileHits.set(name, []);
      fileHits.get(name).push(f);
    }
  }
}
console.log("scanned:", scanned, "files");
for (const [name] of PATTERNS) {
  const list = fileHits.get(name);
  if (!list || !list.length) { console.log(`  0 files | ${name}`); continue; }
  console.log(`  ${list.length} files | ${name}`);
  for (const f of list.slice(0, 10)) console.log(`      ${f}`);
  if (list.length > 10) console.log(`      ... +${list.length - 10} more`);
}
