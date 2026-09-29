/** Drive TASK-003 repair round 1: finish the repair run, then verify. */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const py = (...args) => {
  const r = spawnSync("python", [".workflow-kit/scripts/project_workflow.py", ...args, "--root", "."], { encoding: "utf8", cwd: process.cwd() });
  console.log("$", args.slice(0, 2).join(" "), "-> exit", r.status);
  console.log((r.stdout || "").trim().slice(0, 1400));
  if (r.stderr) console.log("stderr:", r.stderr.trim().slice(0, 600));
  return r;
};

// TASK-003 is blocked from the FAIL review; reopen it for the repair round.
py(
  "unblock", "--task", "TASK-003",
  "--source", "独立审查 r1 判 FAIL 并给出 1 条 finding（工作流路径复用执行器后开始写 queued 字段、抹掉合法排队标记）。总控复核该机制成立，按审查者建议的最小修法完成修复轮 1：新增 clearQueuedMarker 显式开关（默认 false），只有队列路径传 true；工作流路径不再触碰 data.queued。同时补用例 I 作为回归保护，并修正 nodeExecutor 注释中「差异只有三点」的穷举口吻。",
  "--note", "核对：① finding 已复现并修复（用例 I 复现原缺陷、修复后 PASS）；② 三向 ablation 证明 G/H/I 三个用例在移除各自修复后均判 FAIL，非空过断言；③ tsc exit 0、门禁 9/9 PASS exit 0；④ 改动仍限定在 allowed_paths 的 6 个文件内，未触碰 protected_paths（特别是 queue-regression.selfcheck.mjs）。重新进入实现并 finish 以产生新候选，随后 verify + 新一轮独立审查。",
  "--to", "ready",
);

const begin = py("begin", "--task", "TASK-003", "--context", "manager-lead-batch-B-repair1");
const m = /"run_id":\s*"([^"]+)"/.exec(begin.stdout || "");
if (!m) { console.log("no run id"); process.exit(1); }
const RUN = m[1];

const j = JSON.parse(readFileSync(".workflow-kit/tasks/evidence/RUN-b35dfb8808d64ed7bc3275ae7b0976bb-worker-result.json", "utf8"));
j.run_id = RUN;
j.status = "ready_for_verification";
j.changed_files = "auto";
j.requested_actions = [];
j.unresolved_items = [];
j.blocked_reason = null;
j.summary = [
  "TASK-003 修复轮 1（针对独立审查 r1 的唯一 finding）。",
  "finding：REQ-004 复用后工作流路径开始写 runRecords 之外的字段 queued —— 执行器启动时无条件写",
  "queued:false，而改动前的 nodeExecutor 从不碰它；当该节点的队列任务仍停在 queued 时，一次工作流运行会抹掉",
  "一份合法标记，UI 显示未排队、生成按钮重新可点。",
  "修复：ImageGenerationJobOptions 新增 clearQueuedMarker（默认 false），执行器三处 queued 写入改经",
  "queuedMarkerPatch；queueStore.pump() 传 true（队列路径有权消费该标记），工作流路径不传因而完全不碰它。",
  "未采用 withRunRecords 代替该开关：那会把「是否写运行记录」与「是否有权清队列标记」两件语义不同的事耦合起来。",
  "另修正 nodeExecutor 注释中「差异只有三点」的穷举口吻为完整 6 条清单（含错误文案变化与「provider 成功但无图片」",
  "场景下旧实现假成功、新实现正确报错）。",
  "新增门禁用例 I 保护该行为：先建立真实 queued 队列任务，再分别以工作流路径（不传开关）与队列路径（传开关）",
  "调用执行器，断言前者保留 true、后者清为 falsy。",
  "用例 I 自身经两次自纠并以 ablation 证明可判红：初版夹具顺序错误（自愈订阅只清不置位，先写标记会被当陈旧项清掉）",
  "导致假 FAIL，已改为先建活动任务再写节点数据并加前提核对；初版用已 abort 的 signal 调用导致空过（ablation 证实",
  "移除修复仍 PASS），已改为正常跑完只观察启动写入。",
  "三向 ablation（仓库外 %TEMP% 副本）：移除全局额度→用例 G FAIL；移除成功写回前的 abort 复查→用例 H FAIL；",
  "把 queued 清除改回无条件→用例 I FAIL。基线 9/9 PASS、恢复后 9/9 PASS。",
  "当期门禁：tsc --noEmit exit 0；queue-regression.mjs 9/9 PASS exit 0。",
].join(" ");

const DST = `.workflow-kit/tasks/evidence/${RUN}-worker-result.json`;
writeFileSync(DST, JSON.stringify(j, null, 2), "utf8");
JSON.parse(readFileSync(DST, "utf8"));
py("finish", "--run", RUN, "--file", DST);
py("verify", "--task", "TASK-003");
