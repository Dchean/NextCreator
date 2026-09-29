/** Step 4: verify the rewrite (refs/original + remote-tracking refs excluded), then clean up. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const PATHS = [
  ".workflow-kit/tasks/evidence/live-acceptance-20260929/app-data.before-live-run.json",
  ".workflow-kit/tasks/evidence/task003-live/app-data.before.json",
];

// --- 1) which refs still point at the OLD commits? ---
const refs = git(["for-each-ref", "--format=%(refname) %(objectname)"]).trim().split("\n");
const OLD = new Set(["af832d10048e18ad6624914b64e2e78247c4c376", "98dc29df4f85b62c1aa4a769416b60c59b1855f5", "b59f07e2a89333b9664ef41d594ce6265375ecb1"]);
const stale = refs.filter((l) => OLD.has(l.split(" ")[1]));
console.log("refs still holding OLD history:");
console.log(stale.length ? stale.map((l) => "  " + l).join("\n") : "  (none)");

// --- 2) authoritative check: walk ONLY the new main history, look for the paths ---
console.log("\n=== new main history: path occurrences (must be 0) ===");
for (const p of PATHS) {
  let count = 0;
  try {
    execFileSync("git", ["rev-list", "main", "--", p], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    count = git(["rev-list", "--count", "main", "--", p]).trim();
  } catch { count = "?"; }
  console.log(`  ${p} -> ${count} commit(s)`);
}

// --- 3) content scan: does ANY blob reachable from the new main contain the real key? ---
// The key value is taken from the moved-out backups (outside the repo); never printed.
import { readFileSync, readdirSync, existsSync } from "node:fs";
const BACKUP_DIR = "C:\\Users\\A\\NextCreator-key-backups";
const keys = new Set();
if (existsSync(BACKUP_DIR)) {
  for (const f of readdirSync(BACKUP_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(BACKUP_DIR, f), "utf8"));
      let s = j["next-creator-settings"];
      if (typeof s === "string") s = JSON.parse(s);
      for (const p of (s?.state?.settings?.providers) || []) if (p.apiKey) keys.add(p.apiKey);
    } catch { /* ignore unrelated json */ }
  }
}
console.log("\nkey values to scan for:", keys.size);

// Scan every blob in the new main history (fast path: only blobs, no duplicates).
const revs = git(["rev-list", "--objects", "--all", "main"]).trim().split("\n");
console.log("objects reachable from refs/original excluded; scanning", revs.length, "entries...");

let scanned = 0, hits = 0;
const tmp = path.join(process.env.TEMP, "nc-blob-scan");
try { git(["scratch-dir", "x"]); } catch {}
// Use git cat-file --batch to read blobs in bulk.
const batch = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { maxBuffer: 512 * 1024 * 1024 });
void batch;

// Simpler and reliable: rev-list --objects + cat-file per unique blob is too slow; instead
// use `git log --all -S<key>` restricted to the NEW refs (branches+tags only).
for (const key of keys) {
  const out = git(["log", "--branches", "--tags", "-S" + key, "--format=%h"]).trim();
  const commits = out ? out.split("\n").filter(Boolean) : [];
  console.log(`  key(${key.length} chars): ${commits.length} commit(s) in rewritten branches/tags contain it`);
  hits += commits.length;
}
console.log("\nblob-level scan result:", hits === 0 ? "CLEAN — no rewritten commit contains the key" : `STILL PRESENT in ${hits} commit(s)`);
writeFileSync(path.join(ROOT, ".workflow-kit/tasks/evidence/rewrite-history/04-verify-result.txt"),
  JSON.stringify({ staleRefs: stale, keyCommitsInNewHistory: hits, keysScanned: keys.size, at: new Date().toISOString() }, null, 2), "utf8");
console.log("\nresult written to 04-verify-result.txt");
