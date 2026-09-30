/**
 * Repair the version fields damaged by the previous buggy bump, and set them to 0.2.10.
 * The corruption pattern is exactly:  0.2.100.2.6"   (missing opening quote, doubled value).
 */
import { readFileSync, writeFileSync } from "node:fs";

const CORRUPT = /version(\s*[:=]\s*)0\.2\.100\.2\.6"/g;
const GOOD = (m, p1) => "version" + p1 + '"0.2.10"';

for (const f of ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"]) {
  const before = readFileSync(f, "utf8");
  const hits = before.match(CORRUPT);
  if (!hits) { console.log(f, "-> corruption pattern not found (checking plain form)"); }
  const after = before.replace(CORRUPT, GOOD);
  writeFileSync(f, after, "utf8");
  const v = readFileSync(f, "utf8").match(/version(\s*[:=]\s*)"?([^"\r\n]+)"?/);
  console.log(f, "-> now:", v && v[0]);
}

// strict JSON validation for the two JSON files
import { execFileSync } from "node:child_process";
for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    console.log(f, "JSON OK, version =", j.version);
  } catch (e) {
    console.log(f, "JSON BROKEN:", e.message);
    process.exitCode = 1;
  }
}
