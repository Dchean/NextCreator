<!-- project-workflow: generated view; edit task JSON instead -->
# TASK-001 · queueStore 重启恢复与重复入队保护（含零依赖回归门禁）

**状态**：ready

**目标**：修复 REQ-001（应用重启后遗留的 queued 任务永不执行、相关节点永久显示“排队中”并禁用生成）与 REQ-002（缺少同一节点的重复入队保护），并建立一份零新增依赖的行为回归门禁，使这两项缺陷有可执行的红→绿证据。

**依赖**：无
**参考方案**：REF-NODE-STRIP-TYPES
**界面约定**：不涉及界面
**界面检查**：不适用
**修改范围**：src/stores/queueStore.ts, src/hooks/useImageGeneratorExecution.ts, src/App.tsx, src/main.tsx, scripts, package.json

## 验收标准

- REQ-001：应用重启（或 store 重新水合）后，持久化下来的 queued 任务得到明确处置，不再永久停留在 queued。已确认行为按 DEC-restart-queue-resume = 自动恢复并继续生成（会产生真实 API 费用）。节点在该处置完成后不再被 data.queued 永久锁死（ImageGeneratorNode.tsx:215 的 canRun）。
- REQ-001 根因处理：queueStore.ts:209-212 的 partialize 过滤掉 running，而 :213-228 的 onRehydrateStorage 只查找 running，导致该恢复分支恒不可达（已实测穷举证明）。必须在“修正 partialize 使其与恢复分支意图一致”与“按新确认行为重写恢复逻辑”之间做出自洽选择，不允许留下仍然不可达的分支。
- REQ-002：同一节点已有 queued 或 running 任务时，再次触发生成不再产生并发任务；useImageGeneratorExecution.ts 的入队路径存在明确早退检查。
- 回归门禁（红→绿证据，硬性要求）：新增一个零新增依赖的验证脚本，用 Node 原生能力加载并驱动真实 src 代码。脚本必须同时包含两个用例——重启恢复用例与重复入队用例。作者必须实际运行并记录修复前的失败输出与修复后的通过输出；只报告最终 PASS 视为未证明。
- 门禁不得靠断言当前实现来通过：断言对象必须是需求描述的可观察行为（重启后 job 不停留 queued；重复触发不新增 job），而不是内部变量或私有函数调用顺序。
- tsc --noEmit 保持 PASS（strict + noUnusedLocals + noUnusedParameters）。
- 不新增任何需要安装的依赖（不引入 vitest/jest/jsdom 等）；脚本仅用 Node 内置模块。
- 不改动 UI 外观与交互；不改动节点数据字段语义；不改变画布或 app-data.json 的既有字段含义。

## 测试适用性

- 既有行为：按已确认需求变化
- 原始基线：PASS；项目原本没有任何自动化测试（0 测试文件、0 lint、唯一 CI 只在 v* tag 触发且无 typecheck 步骤），因此不存在可继承的旧测试套件。基线由总控自建的两个零依赖探针确立，均已实际运行、退出码 0：(1) probe-queue-store.mjs 复现 REQ-001 —— 模拟重启遗留 queued 任务后 250ms 仍为 queued，显式调用 pump() 后立即转为 error，证明缺失的调用就是启动时的 pump()；(2) probe-partialize-deadbranch.mjs 穷举证明 partialize 恒不输出 running（输出仅 queued,success,error,cancelled），故 queueStore.ts:217-226 的 running 恢复分支不可达，这正是 REQ-001 的根因。两项探针同时确认 queueStore 可在无浏览器、无 Tauri 运行时的情况下被真实驱动。已知限制：vite build 在本会话沙箱因 esbuild spawn EPERM 无法运行，故前端构建与真实运行行为仍属未验证；cargo check 因 TLS 凭证失败未运行。
- 基线证据：.workflow-kit/tasks/evidence/probe-queue-store.mjs
- 需求决定：DEC-restart-queue-resume, DEC-zero-dep-verification
- 替换：queueStore 重启恢复行为（原 partialize 与 onRehydrateStorage 的不可达分支）；用户已确认行为变更：重启后未完成的任务应自动恢复并继续生成，而现状是任务永久卡在 queued。原恢复分支因 partialize 过滤 running 而恒不可达，旧行为（卡死）由用户明确决定替换。；验证：behavior-regression
- 补充：重复入队保护（原 taskManager.isTaskRunning 语义，已在 750e4fd 重构中丢失）；该保护在删除 src/services/taskManager.ts 时丢失，新需求未覆盖，需补充行为测试锁定。；验证：behavior-regression
- 保留：tsc --noEmit 类型门禁；strict + noUnusedLocals + noUnusedParameters 全部开启且当前零诊断，是项目唯一既有的自动化保护，必须继续运行并保持 PASS。；验证：typecheck
- 补充：自动化行为测试套件（原为完全缺失）；基线证明项目不存在任何行为测试；本轮按 DEC-zero-dep-verification 补充零依赖回归门禁，使 REQ-001/REQ-002 具备红→绿可执行证据。；验证：behavior-regression

## 执行与恢复

- 首次开始：None
- 原截止时间：None
- 当前截止时间：None
- 时钟：未开始
- 已用修复轮：0
- 阻塞：无
- 下一步：执行 start/next 获取可继续的动作

## 最近检查点


## 原始证据

[唯一状态记录](../items/TASK-001.json)


卡片是自动生成的视图。Agent 修改任务记录、执行命令或保存检查点后重新生成；不手工把状态改成通过。
