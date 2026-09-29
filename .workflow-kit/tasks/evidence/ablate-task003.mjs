/**
 * Ablation: prove cases G and H actually FAIL when their fix is removed.
 * Works in a WITH-OUTSIDE copy of the repo (%TEMP%) so the real tree is untouched.
 * node_modules is junctioned to avoid copying it.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const COPY = path.join(tmpdir(), "nc-ablation-task003");
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args, cwd) => {
  try {
    const out = execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};
const summarize = (out) => {
  const m = out.match(/汇总：PASS (\d+) \/ FAIL (\d+) \/ ERROR (\d+)/);
  return m ? `PASS=${m[1]} FAIL=${m[2]} ERROR=${m[3]}` : "(no summary)";
};
const caseVerdict = (out, idx) => {
  // verdicts are printed as 判定：<TAG> in order
  const all = [...out.matchAll(/判定：(PASS|FAIL|ERROR)/g)].map((m) => m[1]);
  return all[idx - 1] ?? "(missing)";
};

console.log("=== preparing copy:", COPY);
try { rmSync(COPY, { recursive: true, force: true }); } catch {}
mkdirSync(COPY, { recursive: true });
for (const entry of ["src", "scripts", "package.json", "tsconfig.json"]) {
  cpSync(path.join(ROOT, entry), path.join(COPY, entry), { recursive: true });
}
// junction node_modules so module resolution works without a 1GB copy
try { symlinkSync(path.join(ROOT, "node_modules"), path.join(COPY, "node_modules"), "junction"); } catch (e) { console.log("junction failed:", e.message); }

const GATE = ["--experimental-strip-types", "scripts/queue-regression.mjs"];

// ---- baseline in the copy: must be 8/8 PASS ----
let r = run(GATE, COPY);
console.log("BASELINE (copy, unmodified):", summarize(r.out), "exit=", r.code);
const baselineOk = r.code === 0 && r.out.includes("PASS 8");

// ---- ablation 1: disable the global limiter (case G must FAIL) ----
const limiterPath = path.join(COPY, "src/services/concurrencyLimiter.ts");
const limiterSrc = readFileSync(limiterPath, "utf8");
const ablated1 = limiterSrc.replace(
  `export function tryAcquireGlobalSlot(): (() => void) | null {
  if (waiters.length > 0) return null;
  if (inFlight >= limit) return null;
  inFlight += 1;
  return makeRelease();
}`,
  `export function tryAcquireGlobalSlot(): (() => void) | null {
  return () => {}; // ABLATION: no global limit at all
}`
);
if (ablated1 === limiterSrc) { console.log("!! ablation 1 replacement did not apply"); }
writeFileSync(limiterPath, ablated1, "utf8");
r = run(GATE, COPY);
console.log("ABLATION 1 (no global limit):", summarize(r.out), "exit=", r.code, "| case7(G)=", caseVerdict(r.out, 7));
const ab1Discriminates = caseVerdict(r.out, 7) === "FAIL";
writeFileSync(limiterPath, limiterSrc, "utf8");

// ---- ablation 2: remove the pre-success abort re-check (case H must FAIL) ----
const execPath = path.join(COPY, "src/services/imageGenerationExecution.ts");
const execSrc = readFileSync(execPath, "utf8");
const marker = `    // REQ-006：写回成功结果之前的**最后一次**复查。`;
const idx = execSrc.indexOf(marker);
let ablated2 = execSrc;
if (idx < 0) {
  console.log("!! ablation 2 marker not found");
} else {
  // neutralize the guard block: replace the `if (signal?.aborted) { ... }` that follows the marker
  const guardStart = execSrc.indexOf("if (signal?.aborted) {", idx);
  const guardEnd = execSrc.indexOf("\n    }\n", guardStart);
  if (guardStart > 0 && guardEnd > guardStart) {
    ablated2 = execSrc.slice(0, guardStart) + "if (false) {" + execSrc.slice(guardStart + "if (signal?.aborted) {".length);
    writeFileSync(execPath, ablated2, "utf8");
  }
}
r = run(GATE, COPY);
console.log("ABLATION 2 (no pre-success abort recheck):", summarize(r.out), "exit=", r.code, "| case8(H)=", caseVerdict(r.out, 8));
const ab2Discriminates = caseVerdict(r.out, 8) === "FAIL";
writeFileSync(execPath, execSrc, "utf8");

// ---- restore check: copy is back to 8/8 ----
r = run(GATE, COPY);
console.log("RESTORED (copy):", summarize(r.out), "exit=", r.code);

console.log("\nRESULT:", JSON.stringify({
  baseline8of8: baselineOk,
  ablation1_caseG_fails_without_limit: ab1Discriminates,
  ablation2_caseH_fails_without_recheck: ab2Discriminates,
}, null, 2));

rmSync(COPY, { recursive: true, force: true });
console.log("copy removed");
process.exit(baselineOk && ab1Discriminates && ab2Discriminates ? 0 : 1);
