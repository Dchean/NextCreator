/**
 * Pre-rewrite inventory: locate every commit/path in git history that contains the
 * real API key. NEVER prints the key itself — only counts, hashes, paths, subjects.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const BACKUP_DIR = "C:\\Users\\A\\NextCreator-key-backups";
const git = (args, opts = {}) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

// --- collect candidate key values from the moved-out backups (outside the repo) ---
const keys = new Set();
if (existsSync(BACKUP_DIR)) {
  for (const f of readdirSync(BACKUP_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(BACKUP_DIR, f), "utf8"));
      let s = j["next-creator-settings"];
      if (typeof s === "string") s = JSON.parse(s);
      const provs = (s?.state?.settings?.providers) || [];
      for (const p of provs) if (p.apiKey) keys.add(p.apiKey);
    } catch { /* skip non-app-data json */ }
  }
}
console.log("distinct key values collected from backups:", keys.size);
console.log("key lengths:", [...keys].map((k) => k.length).join(","));
if (keys.size === 0) throw new Error("no key values found in backups; aborting to avoid a blind rewrite");

// --- git inventory ---
const count = git(["rev-list", "--count", "HEAD"]).trim();
const tags = git(["tag", "--list"]).trim().split("\n").filter(Boolean);
console.log("\ntotal commits on HEAD:", count);
console.log("tags:", tags.length, "->", tags.join(" "));

const remotes = git(["remote", "-v"]).trim();
console.log("\nremotes:\n" + remotes);
writeFileSync(path.join(BACKUP_DIR, "remotes-before-rewrite.txt"), remotes + "\n", "utf8");

console.log("\n=== history of the two known paths ===");
for (const p of [
  ".workflow-kit/tasks/evidence/live-acceptance-20260929/app-data.before-live-run.json",
  ".workflow-kit/tasks/evidence/task003-live/app-data.before.json",
]) {
  console.log("\n-- " + p);
  console.log(git(["log", "--all", "--full-history", "--oneline", "--", p]).trim() || "(no commits)");
}

console.log("\n=== pickaxe: commits that add/remove ANY key value (all refs) ===");
for (const key of keys) {
  const out = git(["log", "--all", "-S" + key, "--format=%h %s", "--name-only"]).trim();
  if (!out) { console.log("(no commits contain this key value)"); continue; }
  console.log(out);
  console.log("  -> commits mentioning this key:", out.split("\n").filter((l) => /^[0-9a-f]{7,} /.test(l)).length);
}

// --- does the workflow state reference old commit hashes? (informational) ---
console.log("\n=== workflow-state references to recent commit hashes ===");
for (const f of [".workflow-kit/tasks/PROJECT.json", ".workflow-kit/tasks/PROJECT_STATE.md", ".workflow-kit/notes/RESUME.md"]) {
  try {
    const t = readFileSync(path.join(ROOT, f), "utf8");
    const hits = [...t.matchAll(/\b(?:b59f07e|98dc29d|af832d1|847c692|ecc6c79)\b/g)].map((m) => m[0]);
    console.log(f, "->", hits.length ? hits.join(",") : "(none)");
  } catch { /* file may not exist */ }
}
console.log("\nDONE (pre-rewrite inventory)");
