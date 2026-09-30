/** Accept TASK-003 (verified by r2 PASS) with the user's delegation as source. */
import { spawnSync } from "node:child_process";

const source = [
  "用户指令原文：「每次优化重构完一次打小tag推送，一次性完成所有剩余未完成的工作」。",
  "据此，总控完成第一批 B（REQ-004/005/006）并交付：",
  "① 独立审查 r1 判 FAIL（1 条真实 finding：复用使工作流路径写入 queued 字段、抹掉合法排队标记）→ 总控复核成立，",
  "按审查者建议新增 clearQueuedMarker 显式开关修复，并补门禁用例 I；",
  "② 独立审查 r2 判 PASS（findings=0）：审查者亲自复现 r1 场景确认闭合、自做三向消融证明用例 G/H/I 均有判红能力、",
  "核对 116/116 候选哈希、确认 A–F 断言零改动；",
  "③ 总控独立复跑：tsc exit 0、门禁 9/9 PASS exit 0；自建探针 5/5 确认标记修复（工作流保留、队列清除、显式 false 同默认）。",
  "本地数据零污染（跑前备份跑后逐字节还原）。",
].join("");

const mergeRef = "not_applicable：改动在本迭代提交中入库并打 tag v0.2.9 推送 NextCreator 远端；未合并到其它分支";

const r = spawnSync("python", [
  ".workflow-kit/scripts/project_workflow.py", "accept",
  "--tasks", "TASK-003",
  "--source", source,
  "--merge-ref", mergeRef,
  "--root", ".",
], { encoding: "utf8", cwd: process.cwd() });
console.log("exit:", r.status);
console.log(r.stdout || "");
if (r.stderr) console.log("stderr:", r.stderr.slice(0, 800));
