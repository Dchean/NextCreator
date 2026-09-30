/** Bump the app version in the three release-affecting files. Usage: node bump-version.mjs <new> */
import { readFileSync, writeFileSync } from "node:fs";

const NEW = process.argv[2];
if (!NEW) throw new Error("usage: node bump-version.mjs <version>");

const q = (s) => '"' + s + '"';

const bumpJson = (file) => {
  const before = readFileSync(file, "utf8");
  const m = before.match(/("version"\s*:\s*)"(0\.[0-9.]+)"/);
  if (!m) { console.log(file, "-> pattern miss"); return false; }
  const after = before.replace(m[0], m[1] + q(NEW));
  writeFileSync(file, after, "utf8");
  console.log(file, "->", m[1].trim() + q(NEW));
  return true;
};

const bumpToml = (file) => {
  const before = readFileSync(file, "utf8");
  const m = before.match(/(^version\s*=\s*)"(0\.[0-9.]+)"/m);
  if (!m) { console.log(file, "-> pattern miss"); return false; }
  const after = before.replace(m[0], m[1] + q(NEW));
  writeFileSync(file, after, "utf8");
  console.log(file, "->", m[1].trim() + q(NEW));
  return true;
};

bumpJson("package.json");
bumpJson("src-tauri/tauri.conf.json");
bumpToml("src-tauri/Cargo.toml");

console.log("\nverify:");
console.log("  package.json       ", readFileSync("package.json", "utf8").match(/"version"\s*:\s*"[^"]+"/)[0]);
console.log("  tauri.conf.json    ", readFileSync("src-tauri/tauri.conf.json", "utf8").match(/"version"\s*:\s*"[^"]+"/)[0]);
console.log("  Cargo.toml         ", readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version\s*=\s*"[^"]+"/m)[0]);
