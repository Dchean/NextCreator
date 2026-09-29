import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(".workflow-kit/tasks/evidence/RUN-f90ec6c5056b4f6489b2c44426662352-candidate.json", "utf8"));
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    const keys = Object.keys(v).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
const body = { roots: manifest.roots, files: manifest.files.map(f => ({ path: f.path, sha256: f.sha256 })) };
for (const k of ["missing", "excluded"]) if (manifest[k]) body[k] = manifest[k];
const h = createHash("sha256").update(canon(body), "utf8").digest("hex");
console.log("recomputed digest:", h);
console.log("manifest digest  :", manifest.digest);
console.log("MATCH:", h === manifest.digest);
