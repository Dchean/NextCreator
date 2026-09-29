/** Step 8b: post-push history scan using `git grep` per commit (submodule-safe). */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const CLONE = path.join(process.env.TEMP, "nc-postrewrite-verify2");
const gitC = (args) => String(execFileSync("git", args, { cwd: CLONE, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }));
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
if (!key) throw new Error("key not found");
console.log("scanning for key of length:", key.length);

try { rmSync(CLONE, { recursive: true, force: true }); } catch {}
git(["clone", "--quiet", "https://github.com/Dchean/NextCreator.git", CLONE]);
console.log("cloned");

const commits = gitC(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
console.log("commits:", commits.length);

let scanned = 0, hits = 0;
// -a treats binary as text (we want to find the key even in binary-ish files);
 // --max-count=1 keeps output small; exit code 1 = no match (expected, so ignore failures)
for (const c of commits) {
  let out = "";
  try {
    out = execFileSync("git", ["-C", CLONE, "grep", "-a", "-I", "--fixed-strings", "-l", key, c],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // exit 1 = no match; anything else is a real failure we should see
    const code = e.status;
    if (code !== 0 && code !== 1) console.log("  grep warn @", c.slice(0, 8), "status", code);
    out = e.stdout || "";
  }
  scanned++;
  if (out && out.trim()) {
    hits++;
    console.log("  HISTORY HIT @", c.slice(0, 8), "->", out.trim().split("\n").slice(0, 3).join(", "));
    if (hits > 5) break;
  }
}
console.log(`\nscanned ${scanned}/${commits.length} commits, hits ${hits}`);

// path occurrences across all refs
for (const p of [
  ".workflow-kit/tasks/evidence/live-acceptance-20260929/app-data.before-live-run.json",
  ".workflow-kit/tasks/evidence/task003-live/app-data.before.json",
]) {
  const c = gitC(["rev-list", "--count", "--all", "--", p]).trim();
  console.log(`path occurrences: ${p} -> ${c}`);
}

rmSync(CLONE, { recursive: true, force: true });
console.log("clone removed");
console.log(hits === 0 ? "\n✅ REMOTE HISTORY IS CLEAN — key not found in any commit" : "\n❌ KEY STILL PRESENT IN REMOTE HISTORY");
