import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const real = JSON.parse(readFileSync(path.join(process.env.APPDATA, "com.sy.nextcreator", "app-data.json"), "utf8"));
const settings = JSON.parse(real["next-creator-settings"]);
const realKeys = (settings.state.settings.providers || []).map((p) => p.apiKey).filter(Boolean);
const dir = ".workflow-kit/tasks/evidence/review-probes-TASK-007-r2";
let realHits = [];
for (const f of readdirSync(dir)) {
  let c; try { c = readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
  for (const k of realKeys) if (c.includes(k)) realHits.push(f);
}
console.log("REAL key occurrences in my probe dir:", JSON.stringify(realHits));
const live = readFileSync(path.join(dir, "live-r2-report.json"), "utf8");
console.log("live report contains fake key marker R2KEY-:", live.includes("R2KEY-"));
console.log("live report key fields:", JSON.stringify((live.match(/"[^"]*(Key|key|secret)[^"]*"\s*:/g) || []).slice(0, 10)));
