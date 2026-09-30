/** Update the Rust cache shared-key so the release build refreshes its cache. */
import { readFileSync, writeFileSync } from "node:fs";

const P = ".github/workflows/release.yml";
const t = readFileSync(P, "utf8");
const m = t.match(/shared-key:\s*"([^"]+)"/);
if (!m) { console.log("pattern miss"); process.exit(1); }
console.log("was: shared-key:", JSON.stringify(m[1]));
const after = t.replace(m[0], 'shared-key: "v0.3.0"');
writeFileSync(P, after, "utf8");
console.log("now: shared-key:", readFileSync(P, "utf8").match(/shared-key:\s*"([^"]+)"/)[1]);
