/**
 * Bump app version 0.2.10 -> 0.3.0 across the four release-affecting files.
 * Strict: asserts the expected number of replacements per file, then re-validates the
 * result (JSON.parse for JSON, regex for TOML) so a bad pattern cannot corrupt files.
 */
import { readFileSync, writeFileSync } from "node:fs";

const OLD = "0.2.10";
const NEW = "0.3.0";

const JOBS = [
  { file: "package.json", find: `"version": "${OLD}"`, replace: `"version": "${NEW}"` },
  { file: "src-tauri/tauri.conf.json", find: `"version": "${OLD}"`, replace: `"version": "${NEW}"` },
  { file: "src-tauri/Cargo.toml", find: `version = "${OLD}"`, replace: `version = "${NEW}"` },
  { file: "src-tauri/Cargo.lock", find: `version = "${OLD}"`, replace: `version = "${NEW}"` },
];

for (const job of JOBS) {
  const before = readFileSync(job.file, "utf8");
  const count = before.split(job.find).length - 1;
  if (count < 1) throw new Error(`${job.file}: pattern not found: ${JSON.stringify(job.find)}`);
  const after = before.split(job.find).join(job.replace);
  writeFileSync(job.file, after, "utf8");
  console.log(`${job.file}: replaced ${count} occurrence(s)`);
}

console.log("\n--- re-validation ---");
for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  console.log(`${f}: JSON valid, version = ${j.version}`);
}
{
  const t = readFileSync("src-tauri/Cargo.toml", "utf8");
  const m = t.match(/^version = "([^"]+)"/m);
  console.log(`src-tauri/Cargo.toml: version = ${m ? m[1] : "(NOT FOUND)"}`);
}
{
  const t = readFileSync("src-tauri/Cargo.lock", "utf8");
  const m = t.match(/name = "nextcreator"\r?\nversion = "([^"]+)"/);
  console.log(`src-tauri/Cargo.lock: nextcreator version = ${m ? m[1] : "(NOT FOUND)"}`);
}
