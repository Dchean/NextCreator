/** Pinpoint exactly which commits the pickaxe still reports, and via which refs. */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// collect the real key from the outside backups
const BACKUP_DIR = "C:\\Users\\A\\NextCreator-key-backups";
let key = null;
for (const f of readdirSync(BACKUP_DIR)) {
  if (!f.endsWith(".json")) continue;
  try {
    const j = JSON.parse(readFileSync(path.join(BACKUP_DIR, f), "utf8"));
    let s = j["next-creator-settings"];
    if (typeof s === "string") s = JSON.parse(s);
    for (const p of (s?.state?.settings?.providers) || []) if (p.apiKey) key = p.apiKey;
  } catch {}
}
if (!key) throw new Error("key not found in backups");
console.log("key length:", key.length);

// Enumerate the commits the pickaxe finds, WITHOUT --all, per ref namespace.
for (const ns of [["--branches"], ["--tags"], ["--all"]]) {
  const out = git(["log", ...ns, "-S" + key, "--format=%H %d %s"]).trim();
  const lines = out ? out.split("\n").filter(Boolean) : [];
  console.log(`\n=== pickaxe over ${ns.join(" ")}: ${lines.length} commit(s) ===`);
  for (const l of lines.slice(0, 10)) console.log("  " + l.slice(0, 120));
}

// Also: which refs can even reach the old commits?
console.log("\n=== refs reaching old commit af832d1 ===");
const reach = git(["for-each-ref", "--contains", "af832d10048e18ad6624914b64e2e78247c4c376",
  "--format=%(refname)"]).trim();
console.log(reach || "(none)");
