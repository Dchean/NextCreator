/**
 * Step 6: finish the rewrite.
 *  1. point refs/heads/main at the rewritten tip (same commit the rewritten v0.2.10 tag
 *     now points at — the previous run rewrote tags but left the branch ref behind);
 *  2. delete filter-branch's refs/original/* backups (they alone keep the old history alive);
 *  3. drop the stale remote-tracking ref for the old remote state;
 *  4. expire reflogs and garbage-collect so the old commits lose all anchors;
 *  5. verify: pickaxe over --all finds ZERO commits containing the key.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const git = (args, opts = {}) => {
  try { return { ok: true, out: execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts }) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}`, status: e.status }; }
};

const tagTip = git(["rev-parse", "v0.2.10^{commit}"]).out.trim();
console.log("rewritten v0.2.10 tip:", tagTip);
console.log("current refs/heads/main:", git(["rev-parse", "refs/heads/main"]).out.trim());

// 1) move the branch to the rewritten tip
git(["update-ref", "refs/heads/main", tagTip]);
console.log("refs/heads/main now:", git(["rev-parse", "refs/heads/main"]).out.trim());

// 2) remove filter-branch backup refs
const originals = git(["for-each-ref", "--format=%(refname)", "refs/original/"]).out.trim().split("\n").filter(Boolean);
for (const ref of originals) {
  git(["update-ref", "-d", ref]);
  console.log("deleted backup ref:", ref);
}

// 3) drop the stale remote-tracking ref (it points at the pre-rewrite remote state)
const tracking = git(["for-each-ref", "--format=%(refname)", "refs/remotes/NextCreator/"]).out.trim().split("\n").filter(Boolean);
for (const ref of tracking) {
  git(["update-ref", "-d", ref]);
  console.log("deleted remote-tracking ref:", ref);
}

// 4) expire reflogs + gc (unlink the old commits from the object store)
git(["reflog", "expire", "--expire=now", "--all"]);
git(["gc", "--prune=now", "--aggressive"]);
console.log("reflogs expired, gc done");

// 5) verify
const key = (() => {
  const BACKUP_DIR = "C:\\Users\\A\\NextCreator-key-backups";
  for (const f of readdirSync(BACKUP_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(BACKUP_DIR, f), "utf8"));
      let s = j["next-creator-settings"];
      if (typeof s === "string") s = JSON.parse(s);
      for (const p of (s?.state?.settings?.providers) || []) if (p.apiKey) return p.apiKey;
    } catch {}
  }
  return null;
})();
if (!key) throw new Error("key not found");

console.log("\n=== FINAL VERIFY ===");
const all = git(["for-each-ref", "--format=%(refname) %(objectname)"]).out.trim().split("\n");
const OLD = new Set(["af832d10048e18ad6624914b64e2e78247c4c376", "98dc29df4f85b62c1aa4a769416b60c59b1855f5", "b59f07e2a89333b9664ef41d594ce6265375ecb1"]);
const stale = all.filter((l) => OLD.has(l.split(" ")[1]));
console.log("refs still on old commits:", stale.length ? stale.join(", ") : "(none)");

const pickaxe = git(["log", "--all", "-S" + key, "--format=%H"]).out.trim();
console.log("pickaxe (--all) commits containing key:", pickaxe ? pickaxe.split("\n").length : 0);

// path absence across every ref
for (const p of [
  ".workflow-kit/tasks/evidence/live-acceptance-20260929/app-data.before-live-run.json",
  ".workflow-kit/tasks/evidence/task003-live/app-data.before.json",
]) {
  const c = git(["rev-list", "--count", "--all", "--", p]).out.trim();
  console.log(`path occurrences across ALL refs: ${p} -> ${c}`);
}

// the working tree must be unchanged in content (only history rewritten)
console.log("\nworking tree status entries:", git(["status", "--porcelain"]).out.trim() ? "DIRTY" : "clean");
console.log("HEAD:", git(["rev-parse", "HEAD"]).out.trim());
console.log("v0.2.10:", tagTip);

writeFileSync(path.join(ROOT, ".workflow-kit/tasks/evidence/rewrite-history/06-final-verify.txt"),
  JSON.stringify({ staleRefs: stale, keyCommits: pickaxe ? pickaxe.split("\n").length : 0, head: git(["rev-parse", "HEAD"]).out.trim(), tag: tagTip, at: new Date().toISOString() }, null, 2), "utf8");
console.log("\nDONE");
