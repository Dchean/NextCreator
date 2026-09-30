/** Accept TASK-007 (verified by r2 PASS) with the user's standing directive as source. */
import { spawnSync } from "node:child_process";

const source = [
  "用户本人直接指令（本会话）：「每次优化重构完一次打小tag推送，一次性完成所有剩余未完成的工作」。",
  "据此，总控完成第一批 C（REQ-007 API Key 不再明文落盘）并交付：",
  "① 独立审查 r1 判 FAIL（3 findings：F1 稳态回填把明文写回磁盘 critical、F2 迁移不清洗磁盘 high、",
  "F3 本地凭据进证据目录 medium）→ 总控逐条复核成立并全部修复（markPersistedInKeyring 标志位、",
  "迁移/回填后主动清洁落写、备份移出仓库+git rm --cached+.gitignore 规则）；",
  "② 独立审查 r2 判 PASS（findings=0）：审查者在真实应用上以三轮全新进程启动复现 F1/F2 场景，",
  "确认关闭；对约 1400 个文件用本地凭据做子串扫描 0 命中，确认 F3 关闭；129/129 候选哈希一致；",
  "③ 三道门禁独立重跑通过（tsc 0 / queue-regression 9-9 / cargo build 0）+ cargo test 3 passed；",
  "④ 本地数据 sha256 全程 <LOCAL_DATA_FINGERPRINT>… 未变，本地凭据从未被读取、打印或写入任何文件。",
  "遗留（需用户决定，不在本任务范围）：git 历史 2 个先前提交（v0.2.8/0.2.9 之前的 task003-live 证据）",
  "含本地凭据，需另行决策历史改写或凭据轮换。",
].join("");

const mergeRef = "not_applicable：改动在本迭代提交中入库并打 tag v0.2.10 推送 NextCreator 远端；未合并到其它分支";

const r = spawnSync("python", [
  ".workflow-kit/scripts/project_workflow.py", "accept",
  "--tasks", "TASK-007",
  "--source", source,
  "--merge-ref", mergeRef,
  "--root", ".",
], { encoding: "utf8", cwd: process.cwd() });
console.log("exit:", r.status);
console.log(r.stdout || "");
if (r.stderr) console.log("stderr:", r.stderr.slice(0, 800));
