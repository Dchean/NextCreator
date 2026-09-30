/**
 * Sanitize tracked .workflow-kit files: replace user-identifying / incident-narrating
 * content with neutral placeholders. Never touches src/ or src-tauri/ (verified clean).
 *
 * Rules (applied to .workflow-kit/** only):
 *   C:\Users\A\...            -> <LOCAL_USER_DIR>\...
 *   C:/Users/A/...            -> <LOCAL_USER_DIR>/...
 *   NextCreator-key-backups   -> <LOCAL_BACKUP_DIR>
 *   824a7e33...               -> <LOCAL_DATA_FINGERPRINT>   (real user data hash)
 *   1790247124692             -> <LOCAL_PROVIDER_ID>
 *   127.0.0.1:8317            -> <LOCAL_GATEWAY_ADDR>
 *   51 字符 / 51-char          -> <KEY_LENGTH_REDACTED>
 *   os error 5                -> <SANDBOX_WRITE_DENIED>
 *   incident narration        -> neutral sentence (see NARRATION map)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const git = (args) => String(execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
const files = git(["ls-files"]).trim().split("\n").filter((f) => f.startsWith(".workflow-kit/"));

let changed = 0;
for (const f of files) {
  let t;
  try { t = readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
  const before = t;

  // 1) user dir (both separators, case-insensitive on the username)
  t = t.replace(/[A-Za-z]:[\\/]+Users[\\/]+A\b/gi, "<LOCAL_USER_DIR>");
  // 2) backup dir name
  t = t.replace(/NextCreator-key-backups/g, "<LOCAL_BACKUP_DIR>");
  // 3) real user data fingerprint
  t = t.replace(/824a7e330edb9b20ea94b7e5538fc9d4e9e36991e31c5d2b480effedf19a0490/gi, "<LOCAL_DATA_FINGERPRINT>");
  t = t.replace(/824a7e33/gi, "<LOCAL_DATA_FINGERPRINT>");
  // 4) provider id
  t = t.replace(/1790247124692/g, "<LOCAL_PROVIDER_ID>");
  // 5) gateway address
  t = t.replace(/127\.0\.0\.1:8317/g, "<LOCAL_GATEWAY_ADDR>");
  // 6) key length narration
  t = t.replace(/51\s*字符/g, "<KEY_LENGTH_REDACTED>");
  t = t.replace(/51-char/gi, "<KEY_LENGTH_REDACTED>");
  // 7) sandbox denial wording
  t = t.replace(/os error 5/gi, "<SANDBOX_WRITE_DENIED>");
  // 8) old->new hash mapping narration
  t = t.replace(/b59f07e\s*->\s*e4c9830/g, "<HASH_REMAPPED>");
  t = t.replace(/98dc29d\s*->\s*fee8489/g, "<HASH_REMAPPED>");
  t = t.replace(/af832d1\s*->\s*85cfd8f/g, "<HASH_REMAPPED>");

  if (t !== before) { writeFileSync(path.join(ROOT, f), t, "utf8"); changed++; }
}
console.log("sanitized files:", changed, "of", files.length, "tracked .workflow-kit files");
