/**
 * Ablation for TASK-003's three new gate cases (G, H, I).
 * Works in a copy OUTSIDE the repo (%TEMP%); node_modules is junctioned.
 *
 * Each ablation must make exactly its target case FAIL, proving the case
 * discriminates (i.e. is not a vacuous assertion).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const COPY = path.join(tmpdir(), "nc-ablation-003-full");

const run = (cwd) => {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/queue-regression.mjs"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};
const summary = (out) => {
  const m = out.match(/汇总：PASS (\d+) \/ FAIL (\d+) \/ ERROR (\d+)/);
  return m ? `PASS=${m[1]} FAIL=${m[2]} ERROR=${m[3]}` : "(no summary)";
};
const verdicts = (out) => [...out.matchAll(/判定：(PASS|FAIL|ERROR)/g)].map((m) => m[1]);
const named = (out, label) => {
  // find the case block and read its 判定
  const idx = out.indexOf(label);
  if (idx < 0) return "(case missing)";
  const seg = out.slice(idx, idx + 4000);
  const m = seg.match(/判定：(PASS|FAIL|ERROR)/);
  return m ? m[1] : "(no verdict)";
};

console.log("preparing copy:", COPY);
try { rmSync(COPY, { recursive: true, force: true }); } catch {}
mkdirSync(COPY, { recursive: true });
for (const entry of ["src", "scripts", "package.json", "tsconfig.json"]) {
  cpSync(path.join(ROOT, entry), path.join(COPY, entry), { recursive: true });
}
try { symlinkSync(path.join(ROOT, "node_modules"), path.join(COPY, "node_modules"), "junction"); } catch (e) { console.log("junction:", e.message); }

const restore = new Map();
const patch = (rel, from, to) => {
  const p = path.join(COPY, rel);
  if (!restore.has(rel)) restore.set(rel, readFileSync(p, "utf8"));
  const src = readFileSync(p, "utf8");
  if (!src.includes(from)) { console.log(`!! pattern not found in ${rel}: ${from.slice(0, 60)}`); return false; }
  writeFileSync(p, src.replace(from, to), "utf8");
  return true;
};
const revert = (rel) => {
  if (restore.has(rel)) writeFileSync(path.join(COPY, rel), restore.get(rel), "utf8");
};

const results = {};

// baseline
let r = run(COPY);
console.log("BASELINE:", summary(r.out), "exit", r.code);
results.baseline9of9 = r.code === 0 && r.out.includes("PASS 9");
results.baselineVerdicts = verdicts(r.out);

// ---- ablation G: no global limit ----
patch("src/services/concurrencyLimiter.ts",
  `export function tryAcquireGlobalSlot(): (() => void) | null {
  if (waiters.length > 0) return null;
  if (inFlight >= limit) return null;
  inFlight += 1;
  return makeRelease();
}`,
  `export function tryAcquireGlobalSlot(): (() => void) | null {
  return () => {};
}`);
r = run(COPY);
console.log("ABLATION G (no limit):", summary(r.out), "| case G =", named(r.out, "用例 G："));
results.ablationG_caseG_fails = named(r.out, "用例 G：") === "FAIL";
revert("src/services/concurrencyLimiter.ts");

// ---- ablation H: remove the last abort re-check before the success write ----
const execRel = "src/services/imageGenerationExecution.ts";
const execSrc = readFileSync(path.join(COPY, execRel), "utf8");
const marker = "// REQ-006：写回成功结果之前的**最后一次**复查。";
const mi = execSrc.indexOf(marker);
if (mi < 0) {
  console.log("!! ablation H marker not found");
  results.ablationH_caseH_fails = false;
} else {
  const gs = execSrc.indexOf("if (signal?.aborted) {", mi);
  if (gs < 0) {
    console.log("!! ablation H guard not found");
    results.ablationH_caseH_fails = false;
  } else {
    writeFileSync(path.join(COPY, execRel), execSrc.slice(0, gs) + "if (false) {" + execSrc.slice(gs + "if (signal?.aborted) {".length), "utf8");
    r = run(COPY);
    console.log("ABLATION H (no pre-success recheck):", summary(r.out), "| case H =", named(r.out, "用例 H："));
    results.ablationH_caseH_fails = named(r.out, "用例 H：") === "FAIL";
    writeFileSync(path.join(COPY, execRel), execSrc, "utf8");
  }
}

// ---- ablation I: make the executor clear `queued` unconditionally again ----
const execSrc2 = readFileSync(path.join(COPY, execRel), "utf8");
const patched = execSrc2.replace(
  "const queuedMarkerPatch = clearQueuedMarker ? { queued: false as const } : {};",
  "const queuedMarkerPatch = { queued: false as const };"
);
if (patched === execSrc2) {
  console.log("!! ablation I pattern not found");
  results.ablationI_caseI_fails = false;
} else {
  writeFileSync(path.join(COPY, execRel), patched, "utf8");
  r = run(COPY);
  console.log("ABLATION I (unconditional queued clear):", summary(r.out), "| case I =", named(r.out, "用例 I："));
  results.ablationI_caseI_fails = named(r.out, "用例 I：") === "FAIL";
  writeFileSync(path.join(COPY, execRel), execSrc2, "utf8");
}

// restore check
r = run(COPY);
console.log("RESTORED:", summary(r.out), "exit", r.code);

console.log("\nRESULT:", JSON.stringify(results, null, 2));
rmSync(COPY, { recursive: true, force: true });
console.log("copy removed");
const ok = results.baseline9of9 && results.ablationG_caseG_fails && results.ablationH_caseH_fails && results.ablationI_caseI_fails;
process.exit(ok ? 0 : 1);
