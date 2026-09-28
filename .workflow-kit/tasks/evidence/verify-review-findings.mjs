// 总控验证：独立复现审查者报告的两条假绿路径（不修改任何交付物）
// 手法：复制交付脚本到临时文件，注入最小变异，验证门禁是否给出错误结论；结束后删除。
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = "D:/NextCreator";
const src = path.join(root, "scripts/queue-regression.mjs");
const tmpDir = path.join(root, ".tc-verify-tmp");
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const original = readFileSync(src, "utf8");
const results = [];

function runMutant(label, mutate, expect) {
  const file = path.join(tmpDir, "m-" + label + ".mjs");
  const code = mutate(original);
  if (code === original) {
    results.push({ label, status: "MUTATION-NOT-APPLIED" });
    return;
  }
  // 脚本内部用 SRC = root/src；临时文件放在 .tc-verify-tmp 下需让它仍指向真实 src
  writeFileSync(file, code, "utf8");
  let out = "", code_ = 0;
  try {
    out = execFileSync("node", ["--experimental-strip-types", file], { cwd: root, encoding: "utf8", timeout: 120000 });
  } catch (e) {
    code_ = e.status ?? -1;
    out = (e.stdout || "") + (e.stderr || "");
  }
  const a = /【1】[\s\S]*?判定：(PASS|FAIL|ERROR)/.exec(out);
  const b = /【2】[\s\S]*?判定：(PASS|FAIL|ERROR)/.exec(out);
  const verdictA = a ? a[1] : "?";
  const verdictB = b ? b[1] : "?";
  const got = { A: verdictA, B: verdictB, exit: code_ };
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  results.push({ label, expect, got, ok: pass, tail: out.trim().split("\n").slice(-2).join(" | ") });
}

// —— 变异 1：审查者发现的问题 1 —— 
// 让 executeImageGeneration「在首个 await 前就失败」，使 job 不进入 running；
// 此时 REQ-002 缺陷仍完整存在（仍产生 3 个 job），但活动数采样为 0/1/1
runMutant("MUT1-req002-falsegreen",
  (c) => c.replace(
    'const { executeImageGeneration } = await import("@/services/imageGenerationExecution");',
    'const { executeImageGeneration } = { executeImageGeneration: async () => ({ success: false, error: "mutant: immediate failure" }) };'
  ),
  { A: "FAIL", B: "PASS", exit: 1 });   // 若 B=PASS 即证明假绿（缺陷存在却给绿）

// —— 变异 2：审查者发现的问题 2 ——
// 让恢复只改 job 状态、绝不清 node.data.queued（模拟"job 标 error 但节点仍显示排队中"）
runMutant("MUT2-node-queued-left-true",
  (c) => c.replace(
    'const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);',
    'globalThis.__NC_FORCE_NODE_QUEUED__ = true;\n  const { useQueueStore } = await import(pathToFileURL(path.join(SRC, "stores/queueStore.ts")).href);'
  ),
  { A: "FAIL", B: "FAIL", exit: 1 });

rmSync(tmpDir, { recursive: true, force: true });

console.log("=== 总控独立复现审查发现 ===");
for (const r of results) {
  console.log("");
  console.log("变异:", r.label);
  if (r.status) { console.log("  ", r.status); continue; }
  console.log("  期望门禁结论:", JSON.stringify(r.expect));
  console.log("  实际门禁结论:", JSON.stringify(r.got));
  console.log("  是否按期望:", r.ok ? "是" : "否 ← 说明门禁结论与期望不符");
}
console.log("");
console.log("注：MUT1 的期望 B=PASS 表示‘缺陷存在但门禁给绿’，即假绿被复现。");
console.log("    若 MUT1 实际 B=FAIL，则审查者的发现 1 未被复现。");
