// F3: search the whole repo (tracked + evidence) for any REAL api key value from the
// real app-data.json, WITHOUT printing the key. Also record git-history presence (for the record only).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
const real = JSON.parse(readFileSync(path.join(process.env.APPDATA, "com.sy.nextcreator", "app-data.json"), "utf8"));
const settings = JSON.parse(real["next-creator-settings"]);
const keys = (settings.state.settings.providers || []).map((p) => p.apiKey).filter((k) => k && k.length >= 8);
console.log("real providers with non-empty apiKey:", keys.length, "| lengths:", keys.map((k) => k.length));
// 1) tracked files (current index/worktree)
let trackedHits = [];
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" }).toString().split("\0").filter(Boolean);
console.log("tracked files scanned:", tracked.length);
for (const f of tracked) {
  let content;
  try { content = readFileSync(f, "utf8"); } catch { continue; }
  for (const k of keys) { if (k.length >= 16 && content.includes(k)) trackedHits.push(f); }
}
console.log("tracked files containing a real key:", JSON.stringify([...new Set(trackedHits)]));
// 2) untracked evidence/workflow files
let untrackedHits = [];
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer" }).toString().split("\0").filter(Boolean);
for (const f of untracked) {
  let content;
  try { content = readFileSync(f, "utf8"); } catch { continue; }
  for (const k of keys) { if (k.length >= 16 && content.includes(k)) untrackedHits.push(f); }
}
console.log("untracked files scanned:", untracked.length, "| containing a real key:", JSON.stringify([...new Set(untrackedHits)]));
// 3) git history (for the record; out of scope to fix)
let historyNote = "not checked";
try {
  const args = ["log", "--all", "--oneline", "-S", keys[0]];
  const out = execFileSync("git", args, { encoding: "utf8" }).trim();
  historyNote = out ? out.split("\n").length + " commits in history contain the real key (pickaxe)" : "no commit in history contains the real key";
} catch (e) { historyNote = "history check failed: " + String(e).slice(0, 80); }
console.log("history:", historyNote);
