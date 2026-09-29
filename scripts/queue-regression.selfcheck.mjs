/**
 * 队列回归门禁的**自检脚本**（不是交付门禁本身）
 *
 * 目的：自动验证 scripts/queue-regression.mjs 的判绿条件"有牙"且"可达"，并证明
 *       默认门禁不可被环境变量伪造。它本身不参与 TASK-001 的验收门禁。
 *
 * 运行：node scripts/queue-regression.selfcheck.mjs
 * 退出码：全部自检项符合预期 → 0；任一不符合 → 1
 *
 * 覆盖：
 *   1) 默认门禁（未修复）→ 必须退出码 1；--expect-red → 必须退出码 0
 *   2) 环境变量独立性：设置任意 NC_QUEUE_MUTANT 后，默认模式结论与退出码必须**不变**
 *   3) 变异开关仍可经 CLI 生效（否则第 2 条会因"开关彻底失灵"而假通过）
 *   4) 五种缺陷形态必须被判 FAIL（含批量分支的三类破坏性修复）
 *   5) 绿色对照 full-fix 必须全 PASS（证明断言可被满足，不是永假门禁）
 *
 * 实现说明（沙箱约束）：本环境禁止子进程管道（Node 的 spawnSync + stdio:"pipe" 会 EPERM，
 * 见宿主说明），因此自检用 stdio:"inherit" 让被测门禁的输出直接打到当前终端，再通过门禁的
 * --report-json=<临时文件> 读回结构化结论。这样既不丢证据，也不依赖管道。
 * 本脚本只读取门禁的退出码与报告，不复制其断言逻辑。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(root, "scripts", "queue-regression.mjs");
const NODE_ARGS = ["--experimental-strip-types", TARGET];

// 报告文件放在系统临时目录（不在仓库内，避免污染工作区）
const reportDir = mkdtempSync(path.join(tmpdir(), "nc-queue-selfcheck-"));

/** 运行门禁：输出继承到当前终端，结论通过 JSON 报告读回 */
function run(targetArgs = [], extraEnv = {}) {
  const reportPath = path.join(reportDir, `report-${Math.random().toString(36).slice(2)}.json`);
  const res = spawnSync(process.execPath, [...NODE_ARGS, ...targetArgs, `--report-json=${reportPath}`], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    report = null;
  }
  return { code: res.status, report };
}

/** 把报告压成便于断言/展示的摘要 */
function summarize(report) {
  if (!report) return { pass: null, fail: null, error: null, verdicts: [] };
  return {
    pass: report.pass,
    fail: report.fail,
    error: report.error,
    verdicts: report.cases.map((c) => c.verdict),
  };
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  [OK]  " : "  [NG]  "}${name}`);
  if (detail) console.log(`          ${detail}`);
}

const brief = (r) => {
  const s = summarize(r.report);
  return `exit=${r.code}，PASS ${s.pass} / FAIL ${s.fail} / ERROR ${s.error}`;
};

// ---------------------------------------------------------------------------
// 1) 真实门禁基线
// ---------------------------------------------------------------------------
console.log("== 1) 真实门禁基线（业务缺陷未修复）==");
const baseline = run();
const bSum = summarize(baseline.report);
check(
  "默认模式在未修复的源码上必须 FAIL（退出码 1，6 个用例全部判 FAIL）",
  baseline.code === 1 && bSum.fail === 6 && bSum.error === 0,
  brief(baseline)
);

const expectRed = run(["--expect-red"]);
const rSum = summarize(expectRed.report);
check(
  "--expect-red 在未修复的源码上必须退出码 0（红状态符合预期）",
  expectRed.code === 0 && rSum.fail === 6 && rSum.error === 0,
  brief(expectRed)
);

// ---------------------------------------------------------------------------
// 2) 环境变量独立性 —— 默认门禁不可被环境变量伪造
//    这是本轮返工的核心不变量：TASK-001 的 behavior-regression 用的正是默认模式。
// ---------------------------------------------------------------------------
console.log("");
console.log("== 2) 环境变量独立性（默认门禁不得被 env 改变）==");
for (const value of ["full-fix", "exec-instant-fail", "1", "true", "full-fix,exec-instant-fail"]) {
  const r = run([], { NC_QUEUE_MUTANT: value });
  const s = summarize(r.report);
  const sameExit = r.code === baseline.code;
  const sameVerdicts = JSON.stringify(s.verdicts) === JSON.stringify(bSum.verdicts);
  check(
    `NC_QUEUE_MUTANT=${value} 时默认模式结论不变`,
    sameExit && sameVerdicts,
    `${brief(r)}；用例判定=${s.verdicts.join("/")}（基线 ${bSum.verdicts.join("/")}）`
  );
}

// ---------------------------------------------------------------------------
// 3) 变异开关本身必须仍可通过 CLI 生效
//    否则第 2 条的"独立性"只是因为开关彻底失灵，属于假通过。
// ---------------------------------------------------------------------------
console.log("");
console.log("== 3) 变异开关仍可经 CLI 生效（否则第 2 条会因开关失灵而假通过）==");
const viaCli = run(["--self-check=full-fix"]);
const cSum = summarize(viaCli.report);
check(
  "--self-check=full-fix 必须让门禁转为全 PASS（退出码 0，6 个用例全 PASS）",
  viaCli.code === 0 && cSum.pass === 6,
  brief(viaCli)
);

// ---------------------------------------------------------------------------
// 4) 缺陷形态必须被判 FAIL —— 断言有牙
//    (a) 批量无保护由基线直接覆盖（用例 C：4/8/12）
//    (b) 守卫误置于批量循环内 / (c) store 层任意去重 / (d) 任意历史 job 去重
//    (e) 用例 A 的"job 处置了但节点标记未清"
//    (f) 用例 B 的"执行快速失败导致瞬时采样抓不到"
//    (g) 守卫语义残缺（仅 running / 仅 queued / 全局单飞）
//    (h) 守卫位置太靠上（入口级：用例 E 重叠窗口、用例 F retry 路径）
// ---------------------------------------------------------------------------
console.log("");
console.log("== 4) 缺陷形态必须被判 FAIL ==");
const defectForms = [
  // 批量分支的破坏性修复
  ["guard-inside-batch-loop", "store 层守卫（批量分支同语义）"],
  ["store-dedupe-any", "store 层按 nodeId 任意去重（批量被截断 + retry 被吞）"],
  ["any-history-dedupe", "对任意历史 job 去重（锁死重生成 + retry 被吞）"],
  // 守卫语义残缺（用例 D 必须把它们与正确语义区分开）
  ["guard-running-only", "【仅 running】守卫（store 层）"],
  ["entry-guard-running-only", "【仅 running】守卫（入口级：用例 D/E/F 都要判出）"],
  ["guard-queued-only", "【仅 queued】守卫"],
  ["guard-global-single", "【全局单飞】守卫（禁止不同节点并发）"],
  // 守卫位置太靠上：P1 形态（handleGenerate 顶部、语义完全正确）
  ["entry-guard-active", "【入口级 queued||running】守卫位置太靠上（用例 E/F 必须判出）"],
  // 旧场景
  ["partial-fix-job-only", "用例 A：job 处置了但节点 queued 标记未清"],
  ["exec-instant-fail", "用例 B：执行快速失败，瞬时采样抓不到重复"],
];
for (const [mutant, label] of defectForms) {
  const r = run([`--self-check=${mutant}`]);
  const s = summarize(r.report);
  check(`${label} → 必须 FAIL`, r.code !== 0 && s.fail > 0, brief(r));
}

// P1 形态（入口级、语义正确）的精确画像：REQ-002 的单节点用例 B/C/D 都被它"骗过"，
// 只有用例 E（并发点击）与 F（retry）能判出它——这正是本轮新增两条用例的目的。
console.log("");
console.log("== 4b) 入口级守卫（P1）的精确画像 ==");
const p1 = run(["--self-check=entry-guard-active"]);
const p1s = summarize(p1.report);
const p1Cases = p1.report ? p1.report.cases.map((c) => c.verdict) : [];
check(
  "入口级 queued||running 守卫：只有用例 E/F 判 FAIL，B/C/D 仍 PASS（证明 E/F 不可省）",
  p1.code === 1 && p1Cases[1] === "PASS" && p1Cases[2] === "PASS" && p1Cases[3] === "PASS" &&
    p1Cases[4] === "FAIL" && p1Cases[5] === "FAIL",
  `逐用例判定=${p1Cases.join("/")}（A/B/C/D/E/F）`
);

// 正确实现位置的对照：store 层判定（同步）能同时解决"入口级守卫"在 E/F 上的两处漏判，
// 但"逐个 enqueue 判定"仍会把整批拆分截断为 1（用例 C 失败）——所以正确修复还需要
// 整批原子判定，这正是 full-fix 绿色对照所模拟的形态。
console.log("");
console.log("== 4c) 正确实现位置的对照（store 层判定解决 E/F；批量仍需整批原子）==");
const storeLayer = run(["--self-check=guard-active"]);
const slCases = storeLayer.report ? storeLayer.report.cases.map((c) => c.verdict) : [];
check(
  "store 层 queued||running 守卫（逐个判定）：用例 B/D/E/F 全 PASS（位置正确）",
  slCases[1] === "PASS" && slCases[3] === "PASS" && slCases[4] === "PASS" && slCases[5] === "PASS",
  `逐用例判定=${slCases.join("/")}（A/B/C/D/E/F）`
);
check(
  "同上的逐个判定仍会截断批量（用例 C 必须 FAIL）——证明批量需要整批原子判定",
  slCases[2] === "FAIL",
  `用例 C 判定=${slCases[2]}`
);

// ---------------------------------------------------------------------------
// 5) 绿色对照：正确修复必须全 PASS —— 断言可达
// ---------------------------------------------------------------------------
console.log("");
console.log("== 5) 绿色对照（断言必须可被满足，不是永假门禁）==");
const green = run(["--self-check=full-fix"]);
const gSum = summarize(green.report);
check(
  "正确修复（full-fix）→ 六个用例全 PASS、退出码 0",
  green.code === 0 && gSum.pass === 6 && gSum.fail === 0,
  brief(green)
);

// 慢速执行的正确修复：用例 C 必须判 ERROR（基础设施无法评估），而不是 FAIL（假红）
console.log("");
console.log("== 6) 慢速执行下的正确修复（用例 C 必须 ERROR 而非 FAIL）==");
const slow = run(["--self-check=full-fix,exec-slow"]);
const slowSum = summarize(slow.report);
const cVerdict = slow.report ? slow.report.cases[2]?.verdict : null;
check(
  "每个 job 6s（超过 5000ms 窗口）→ 用例 C 判 ERROR，且不被计为业务缺陷 FAIL",
  cVerdict === "ERROR" && slowSum.error === 1 && slowSum.fail === 0,
  `${brief(slow)}；用例 C 判定=${cVerdict}`
);

// ---------------------------------------------------------------------------
// 7) 未知自检键名必须立刻失败（防止"空过验证"）
//    历史教训：文档里写过 guard-inside-batch-loop 但没注册进注入表，键名静默退化为默认模式，
//    对应的自检项恒真通过——这种"看起来测过、其实什么都没注入"的坑必须被挡住。
// ---------------------------------------------------------------------------
console.log("");
console.log("== 7) 未知自检键名必须立刻失败（非 0 退出）==");
for (const bad of ["guard-global-single-flight", "does-not-exist", "entry-guard-runningonly"]) {
  const r = run([`--self-check=${bad}`]);
  check(
    `未知键名 ${bad} → 必须非 0 退出且不产生报告（即未执行任何用例）`,
    r.code !== 0 && r.report === null,
    `exit=${r.code}，报告=${r.report === null ? "未生成（未执行用例）" : "已生成（说明静默退化了！）"}`
  );
}
const mixed = run(["--self-check=full-fix,typo-key"]);
check(
  "合法键名 + 未知键名混用 → 也必须失败（不得只跑合法的那部分）",
  mixed.code !== 0 && mixed.report === null,
  `exit=${mixed.code}，报告=${mixed.report === null ? "未生成" : "已生成（说明静默退化了！）"}`
);

// ---------------------------------------------------------------------------
rmSync(reportDir, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
console.log("");
console.log("-".repeat(78));
console.log(`SELF-CHECK 汇总：${checks.length - failed.length}/${checks.length} 项符合预期`);
if (failed.length > 0) {
  console.log("不符合预期的项：");
  for (const f of failed) console.log(`  - ${f.name}`);
  console.log("EXIT CODE: 1");
  process.exitCode = 1;
} else {
  console.log("EXIT CODE: 0");
  process.exitCode = 0;
}
