/**
 * Step 3: rewrite history to remove the two key-bearing files from EVERY commit.
 *
 * Why git filter-branch --index-filter here:
 *  - git-filter-repo is not installed (pip + network would be needed);
 *  - the key exists in exactly 2 paths, so an index-filter that `git rm --cached --ignore-unmatch`
 *    those paths is precise and does not touch any other file's history;
 *  - --index-filter never checks out the working tree, so it is fast and cannot corrupt
 *    the current working tree;
 *  - --tag-name-filter cat rewrites annotated tags so they point at the rewritten commits.
 *
 * Safety: full mirror clone + bundle backups already exist outside the repo (step 2).
 * Only refs under refs/heads/* and refs/tags/* are rewritten; refs/remotes/* are NOT
 * touched (the remote-tracking ref NextCreator/main is deliberately left pointing at the
 * old history so we can verify the old value afterwards, then it is dropped).
 */
import { execFileSync } from "node:child_process";

const ROOT = "D:\\NextCreator";
const git = (args, opts = {}) => {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}`, status: e.status };
  }
};

const PATHS = [
  ".workflow-kit/tasks/evidence/live-acceptance-20260929/app-data.before-live-run.json",
  ".workflow-kit/tasks/evidence/task003-live/app-data.before.json",
];

const headBefore = git(["rev-parse", "HEAD"]).out.trim();
console.log("HEAD before:", headBefore);

// Sanity: the working tree must be clean, otherwise filter-branch may refuse or mix states.
const st = git(["status", "--porcelain"]).out.trim();
if (st) {
  console.log("!! working tree is NOT clean; aborting to avoid mixing states. Entries:");
  console.log(st.split("\n").slice(0, 10).join("\n"));
  process.exit(2);
}

// Only rewrite refs that can contain the key: all local branches + tags.
// (refs/remotes/* are excluded so the old remote-tracking ref survives for verification.)
const r = git([
  "filter-branch",
  "--force",
  "--index-filter",
  "git rm --cached --ignore-unmatch " + PATHS.map((p) => JSON.stringify(p)).join(" "),
  "--prune-empty",               // drop commits that become empty after removal
  "--tag-name-filter", "cat",    // rewrite annotated tags onto rewritten commits
  "--",                          // rewrite ALL refs under refs/heads and refs/tags
  "--branches", "--tags",
]);

console.log("--- filter-branch exit:", r.ok ? 0 : r.status);
console.log(r.out.split("\n").slice(-25).join("\n"));
if (!r.ok) { console.log("!! filter-branch FAILED"); process.exit(1); }

const headAfter = git(["rev-parse", "HEAD"]).out.trim();
console.log("\nHEAD after :", headAfter);
console.log("changed    :", headAfter !== headBefore);

// The two paths must now be absent from the ENTIRE rewritten history.
console.log("\n=== verify: no commit in the new history contains either path ===");
for (const p of PATHS) {
  const log = git(["log", "--all", "--full-history", "--oneline", "--", p]).out.trim();
  console.log((log ? "STILL PRESENT: " + log : "absent (good)") + "  <- " + p);
}
