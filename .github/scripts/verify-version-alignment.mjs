/**
 * CI guard: the pushed tag must equal the app version in every release-affecting file.
 *
 * Why: the installer filename comes from `tauri.conf.json`'s `version`, while the Release
 * name comes from the git tag. If they drift, the release page says "v0.3.0" but ships
 * `NextCreator_0.2.10_*.exe`, which is confusing and previously happened.
 *
 * Runs on tag pushes only. Exits non-zero (failing the job) on any mismatch.
 */
import { readFileSync } from "node:fs";

const tag = process.env.GITHUB_REF_NAME || "";
const isTag = (process.env.GITHUB_REF_TYPE || "") === "tag";

if (!isTag) {
  console.log(`[align] not a tag push (ref_type=${process.env.GITHUB_REF_TYPE}); skipping tag/version check`);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const cargo = (readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
const lock = (readFileSync("src-tauri/Cargo.lock", "utf8").match(/name = "nextcreator"\r?\nversion = "([^"]+)"/) || [])[1];

console.log("[align] tag              :", tag);
console.log("[align] package.json     :", pkg);
console.log("[align] tauri.conf.json  :", tauri);
console.log("[align] Cargo.toml       :", cargo);
console.log("[align] Cargo.lock       :", lock);

const problems = [];
if (!tag.startsWith("v")) problems.push(`tag "${tag}" does not start with "v"`);
if (tag !== `v${pkg}`) problems.push(`tag "${tag}" != "v${pkg}" (package.json)`);
if (pkg !== tauri) problems.push(`package.json "${pkg}" != tauri.conf.json "${tauri}"`);
if (pkg !== cargo) problems.push(`package.json "${pkg}" != Cargo.toml "${cargo}"`);
if (pkg !== lock) problems.push(`package.json "${pkg}" != Cargo.lock "${lock}"`);

if (problems.length) {
  for (const p of problems) console.log(`::error::版本未对齐：${p}`);
  console.log("\n[align] FAILED — 安装包文件名会与 Release 名称不一致。");
  console.log("[align] 修复：把所有版本字段升到同一版本号，再重打 tag（例如 tag v0.3.1 → 版本 0.3.1）。");
  process.exit(1);
}
console.log("\n[align] OK — tag、package.json、tauri.conf.json、Cargo.toml、Cargo.lock 完全一致");
