import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
const real = JSON.parse(readFileSync(path.join(process.env.APPDATA, "com.sy.nextcreator", "app-data.json"), "utf8"));
const settings = JSON.parse(real["next-creator-settings"]);
const keys = (settings.state.settings.providers || []).map((p) => p.apiKey).filter((k) => k && k.length >= 16);
const ignored = execFileSync("git", ["ls-files", "--ignored", "--others", "--exclude-standard", "-z"], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 }).toString().split("\0").filter(Boolean).filter((f) => !f.startsWith("node_modules") && !f.startsWith("src-tauri/target"));
console.log("ignored files scanned (excl node_modules/target):", ignored.length);
let hits = [];
for (const f of ignored) {
  let c; try { c = readFileSync(f, "utf8"); } catch { continue; }
  for (const k of keys) if (c.includes(k)) hits.push(f);
}
console.log("ignored files containing real key:", JSON.stringify([...new Set(hits)]));
