/** Repair line 4 in both JSON files: `"version": 0.2.100.2.6",` -> `"version": "0.2.10",` */
import { readFileSync, writeFileSync } from "node:fs";

const BAD = '"version": 0.2.100.2.6",';
const GOOD = '"version": "0.2.10",';

for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
  const t = readFileSync(f, "utf8");
  if (!t.includes(BAD)) { console.log(f, "-> bad pattern not found; line4 =", JSON.stringify(t.split(/\r?\n/)[3])); continue; }
  const after = t.replace(BAD, GOOD);
  writeFileSync(f, after, "utf8");
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    console.log(f, "REPAIRED, JSON valid, version =", j.version);
  } catch (e) {
    console.log(f, "STILL BROKEN:", e.message);
    process.exitCode = 1;
  }
}
