/** Step 8: post-push verification — clone from GitHub, scan working tree + full history. */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const CLONE = path.join(process.env.TEMP, "nc-postrewrite-verify");
const gitC = (args) => execFileSync("git", args, { cwd: CLONE, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const git = (args) => String(execFileSync("git", args, { cwd: "D:\\NextCreator", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

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
console.log("scanning for key of length:", key.length);

try { rmSync(CLONE, { recursive: true, force: true }); } catch {}
git(["clone", "--quiet", "https://github.com/Dchean/NextCreator.git", CLONE]);
console.log("cloned from GitHub");

// remote refs state
const remote = git(["ls-remote", "NextCreator"]).trim().split("\n");
const mainLine = remote.find((l) => l.endsWith("refs/heads/main"));
const localMain = git(["rev-parse", "refs/heads/main"]).trim();
console.log("remote main:", mainLine ? mainLine.split("\t")[0] : "(missing)");
console.log("local  main:", localMain);
console.log("MATCH:", Boolean(mainLine && mainLine.startsWith(localMain)));
console.log("remote tag count:", remote.filter((l) => l.includes("refs/tags/")).length);
const OLD = new Set(["af832d10048e18ad6624914b64e2e78247c4c376", "98dc29df4f85b62c1aa4a769416b60c59b1855f5", "b59f07e2a89333b9664ef41d594ce6265375ecb1"]);
console.log("remote refs on old commits:", remote.filter((l) => OLD.has(l.split("\t")[0])).length || "(none)");

// working-tree scan
let hits = 0, scanned = 0;
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "target" || e.name === "dist") continue;
    const fp = path.join(d, e.name);
    if (e.isDirectory()) walk(fp);
    else { scanned++; try { if (readFileSync(fp, "utf8").includes(key)) { hits++; console.log("  WT HIT:", fp); } } catch {} }
  }
};
walk(CLONE);
console.log(`working tree: scanned ${scanned}, hits ${hits}`);

// full-history blob scan
const hist = gitC(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
console.log("commits in remote history:", hist.length);
let histHits = 0, checked = 0;
for (const c of hist) {
  const blobs = gitC(["ls-tree", "-r", "--name-only", c]).trim().split("\n").filter(Boolean);
  for (const f of blobs) {
    checked++;
    const t = gitC(["show", c + ":" + f]);
    if (t.includes(key)) { histHits++; console.log("  HISTORY HIT:", c.slice(0, 8), f); if (histHits > 5) break; }
  }
  if (histHits > 5) break;
}
console.log(`history scan: ${checked} blob revisions checked, hits ${histHits}`);

for (const p of [
  ".workflow-kit/tasks/evidence/live-acceptance-20260929/app-data.before-live-run.json",
  ".workflow-kit/tasks/evidence/task003-live/app-data.before.json",
]) {
  const c = gitC(["rev-list", "--count", "--all", "--", p]).trim();
  console.log(`remote path occurrences: ${p} -> ${c}`);
}

rmSync(CLONE, { recursive: true, force: true });
console.log("clone removed");
console.log(hits === 0 && histHits === 0 ? "\n✅ REMOTE IS CLEAN — key is gone from GitHub" : "\n❌ REMOTE STILL CONTAINS THE KEY");
