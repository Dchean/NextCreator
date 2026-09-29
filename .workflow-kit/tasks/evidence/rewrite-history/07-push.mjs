/**
 * Step 7: force-push the rewritten history to the user's NextCreator remote.
 *
 * Deleted on the remote: main + every tag (old objects become unreachable there).
 * Repushed: rewritten main + all rewritten tags.
 * origin (MoonWeSif) is NOT touched — it never received this history.
 *
 * A post-push verification clones from GitHub into %TEMP% and scans for the key.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const git = (args) => {
  try {
    return { out: execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) };
  } catch (e) {
    const msg = `${e.stdout || ""}${e.stderr || ""}`;
    throw new Error("git " + args.join(" ") + " failed: " + msg.slice(0, 400));
  }
};

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
if (!key) throw new Error("key not found for verification");

const tags = git(["tag", "--list"]).out.trim().split("\n").filter((t) => t && t !== "main");

console.log("1) force-delete remote refs that hold the old history");
git(["push", "NextCreator", "--force", "--delete",
  "refs/heads/main",
  ...tags.map((t) => "refs/tags/" + t),
]);
console.log("   deleted main + " + tags.length + " tags");

console.log("\n2) push rewritten main");
git(["push", "NextCreator", "refs/heads/main:refs/heads/main"]);
console.log("   main pushed");

console.log("\n3) push rewritten tags");
git(["push", "NextCreator", ...tags.map((t) => "refs/tags/" + t + ":refs/tags/" + t)]);
console.log("   pushed " + tags.length + " tags");

console.log("\n4) remote state after push");
const remote = git(["ls-remote", "NextCreator"]).out.trim().split("\n");
const main = remote.find((l) => l.endsWith("refs/heads/main"));
console.log("  remote main:", main ? main.split("\t")[0] : "(missing)");
const localMain = git(["rev-parse", "refs/heads/main"]).out.trim();
console.log("  local  main:", localMain);
console.log("  MATCH:", main && main.startsWith(localMain));

// remote must have NO tag/branch pointing at the old commits
const OLD = new Set(["af832d10048e18ad6624914b64e2e78247c4c376", "98dc29df4f85b62c1aa4a769416b60c59b1855f5", "b59f07e2a89333b9664ef41d594ce6265375ecb1"]);
const staleRemote = remote.filter((l) => OLD.has(l.split("\t")[0]));
console.log("  remote refs on old commits:", staleRemote.length ? staleRemote.join(", ") : "(none)");

// 5) clone from GitHub and scan for the key
console.log("\n5) clone from GitHub and scan for the real key");
const CLONE = path.join(process.env.TEMP, "nc-postrewrite-verify");
try { rmSync(CLONE, { recursive: true, force: true }); } catch {}
git(["clone", "--quiet", "https://github.com/Dchean/NextCreator.git", CLONE]);
let hits = 0, scanned = 0;
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "target" || e.name === "dist") continue;
    const fp = path.join(d, e.name);
    if (e.isDirectory()) walk(fp);
    else { scanned++; try { if (readFileSync(fp, "utf8").includes(key)) { hits++; console.log("  HIT:", fp); } } catch {} }
  }
};
walk(CLONE);
console.log(`  working tree: scanned ${scanned}, hits ${hits}`);

// full history scan on the clone (every commit of every ref)
const hist = execFileSync("git", ["-C", CLONE, "rev-list", "--all"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
console.log("  commits in remote history:", hist.length);
let histHits = 0;
for (const c of hist) {
  const blobs = git(["-C", CLONE, "ls-tree", "-r", "--name-only", c]).out.trim().split("\n").filter(Boolean);
  for (const f of blobs) {
    const t = git(["-C", CLONE, "show", c + ":" + f]).out;
    if (t.includes(key)) { histHits++; console.log("  HISTORY HIT:", c.slice(0, 8), f); if (histHits > 5) break; }
  }
  if (histHits > 5) break;
}
console.log("  history scan hits:", histHits);

// also scan for the two removed paths across all remote history
for (const p of [
  ".workflow-kit/tasks/evidence/live-acceptance-20260929/app-data.before-live-run.json",
  ".workflow-kit/tasks/evidence/task003-live/app-data.before.json",
]) {
  const c = execFileSync("git", ["-C", CLONE, "rev-list", "--count", "--all", "--", p], { encoding: "utf8" }).trim();
  console.log(`  remote path occurrences: ${p} -> ${c}`);
}

rmSync(CLONE, { recursive: true, force: true });
console.log("\ncleanup clone removed");
console.log(hits === 0 && histHits === 0 ? "\nREMOTE IS CLEAN" : "\nREMOTE STILL CONTAINS THE KEY — DO NOT CONSIDER THIS DONE");
