/**
 * Step 2: full safety backups BEFORE rewriting history.
 *  1. mirror clone of the local repo (all refs) -> outside the repo
 *  2. plain git bundle (single file, restorable)
 *  3. tag/branch inventory text
 * Everything lands in C:\Users\A\NextCreator-key-backups\pre-rewrite\
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const OUT = "C:\\Users\\A\\NextCreator-key-backups\\pre-rewrite";
const git = (args, opts = {}) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

if (existsSync(OUT)) throw new Error("backup dir already exists: " + OUT + " (refusing to overwrite)");
mkdirSync(OUT, { recursive: true });

// 1) mirror clone (keeps every ref: branches, tags, notes)
console.log("mirror clone ...");
execFileSync("git", ["clone", "--mirror", ROOT, path.join(OUT, "mirror.git")], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
console.log("  ok ->", path.join(OUT, "mirror.git"));

// 2) bundle (single-file restore artifact)
console.log("git bundle ...");
git(["bundle", "create", path.join(OUT, "NextCreator-full.bundle"), "--all"]);
console.log("  ok ->", path.join(OUT, "NextCreator-full.bundle"));

// 3) inventory
const inv = {
  createdAt: new Date().toISOString(),
  headBefore: git(["rev-parse", "HEAD"]).trim(),
  mainBefore: git(["rev-parse", "NextCreator/main"]).trim(),
  tags: git(["show-ref", "--tags"]).trim(),
  branches: git(["show-ref", "--heads"]).trim(),
  remotes: git(["remote", "-v"]).trim(),
  restore: [
    "mirror restore : git clone " + path.join(OUT, "mirror.git") + " NextCreator-restored",
    "bundle restore  : git clone " + path.join(OUT, "NextCreator-full.bundle") + " NextCreator-restored",
    "or fetch        : git fetch " + path.join(OUT, "NextCreator-full.bundle") + " 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'",
  ],
};
writeFileSync(path.join(OUT, "inventory.json"), JSON.stringify(inv, null, 2), "utf8");
console.log("\ninventory written. HEAD before =", inv.headBefore);
console.log("main on NextCreator remote before =", inv.mainBefore);
console.log("\nALL BACKUPS COMPLETE:", OUT);
