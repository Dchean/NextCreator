<!-- project-workflow: generated view; edit task JSON instead -->
# 接手与恢复笔记

任何 Agent 接手前先读本文件，再运行 `python .workflow-kit/scripts/project_workflow.py resume --root .`。本文件由任务记录、检查点和日志生成；事实以 JSON 记录和原始证据为准。

## 当前状态

**项目进度 · NextCreator**

目标：为 NextCreator（可视化节点 AI 内容生成工作流桌面工具）建立可维护、稳定的继续演进基础，支持持续增加新节点与 AI 能力；本轮先做评估，不预设重构。

当前阶段：**分步实施**

阶段目标：落实已确认的完整范围，逐步交付并保持已验收行为：重启后遗留的 queued 任务永不执行，节点持续显示“排队中”并禁用生成。queueStore.ts:209-212 持久化了 queued 但 :213-228 只修 running；pump() 全项目仅 3 处调用，启动时无人调用。；缺少同一节点的重复入队保护（taskManager 时代的 isTaskRunning 语义未迁移）。useImageGeneratorExecution.ts:62 前无早退检查，连点会创建多个 job 并发写同一 node.data。；删除零引用死代码：imageService.ts（312 行）与 imageCompression.ts（81 行）共 393 行，全项目零外部 importer，而 tsc 在 noUnusedLocals 开启下仍 PASS，证明现有门禁抓不到整模块死代码。

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| 需求与目标 | 明确目标、已有 Bug、新功能、其他要求、质量目标和执行边界 | 已完成 |
| 分析与方案 | 记录参考、原始基线状态与限制，说明维护、稳定和性能取舍，并确认路线 | 已完成 |
| 界面预览 | 验证关键流程、整体设计和控件完整状态，确认后沿用前端实现 | 不适用 |
| 分步实施 | 落实已确认的完整范围，逐步交付并保持已验收行为：重启后遗留的 queued 任务永不执行，节点持续显示“排队中”并禁用生成。queueStore.ts:209-212 持久化了 queued 但 :213-228 只修 running；pump() 全项目仅 3 处调用，启动时无人调用。；缺少同一节点的重复入队保护（taskManager 时代的 isTaskRunning 语义未迁移）。useImageGeneratorExecution.ts:62 前无早退检查，连点会创建多个 job 并发写同一 node.data。；删除零引用死代码：imageService.ts（312 行）与 imageCompression.ts（81 行）共 393 行，全项目零外部 importer，而 tsc 在 noUnusedLocals 开启下仍 PASS，证明现有门禁抓不到整模块死代码。 | 当前 |
| 回归与审查 | 以需求、失败路径、适用界面检查、维护性和性能证据核对当前组合候选 | 分批推进 |
| 验收与交付 | 核对完整范围，交付可运行成果、使用说明及适用的恢复办法 | 待推进 |

**完整验收目标**：第一批 A：queueStore 启动恢复（重启后遗留 queued 任务能正确处置，节点不再卡在“排队中”）；恢复同一节点重复入队保护；删除 393 行零引用死代码（imageService.ts 312 行 + imageCompression.ts 81 行）后 tsc 仍 PASS。；第一批 B：建立全局单一并发上限（不再出现 queueStore 2 × workflowEngine 3 各自为政）；nodeExecutor 的图片生成路径复用 executeImageGeneration 实现，消除最大一处重复；取消语义补全（在途返回后复查 aborted）。；第一批 C：API Key 不再以明文形式落盘，并配套旧数据迁移（用户已授权改数据格式）。；第一批 D：清理冗余依赖与构建产物（双锁文件、已废弃的 @types/uuid），不影响运行行为。；每项以真实命令验证（tsc + 适用的人工回归路径），并由未参与实现的新子代理独立审查后交用户验收。

**质量目标**：维护性—目标：同一业务流程只保留一份执行实现；service 层不再反向依赖 components；删除全部零引用死代码。可核对方式：grep 确认单一实现入口、tsc --noEmit PASS、审查者核对无新增重复。；稳定性—目标：消除已确认的用户可见缺陷（REQ-001、REQ-002），使取消语义与并发边界可预期。可核对方式：按人工回归清单逐条复现（手动生成 / 工作流 / LLM / 批量 / 重启后队列），记录实际命令与观察结果。

**性能安排**：用户反馈规模不大但曾感觉卡顿；已识别的三处性能可疑点均属未经测量的静态推断，本轮 A-D 四项改造不改变渲染与数据规模，无代表性负载可定义，故本轮不建立性能基准。REQ-009 记为待办，待用户确认可接受场景与目标后另行测量，不做无证据的优化。

已建任务 1 项：已验收 0，待验收 0，阻塞 0。

| 任务 | 状态 | 目标 / 下一步 |
| --- | --- | --- |
| [TASK-001 · queueStore 重启恢复与重复入队保护（含零依赖回归门禁）](<../tasks/cards/TASK-001.md>) | 待执行 | 修复 REQ-001（应用重启后遗留的 queued 任务永不执行、相关节点永久显示“排队中”并禁用生成）与 REQ-002（缺少同一节点的重复入队保护），并建立一份零新增依赖的行为回归门禁，使这两项缺陷有可执行的红→绿证据。 |

**已确认但尚未拆分的需求**：删除零引用死代码：imageService.ts（312 行）与 imageCompression.ts（81 行）共 393 行，全项目零外部 importer，而 tsc 在 noUnusedLocals 开启下仍 PASS，证明现有门禁抓不到整模块死代码。；执行链重复：手动路径 queueStore→imageGenerationExecution.ts（470 行）与工作流路径 workflowEngine:435→nodeExecutor.ts:390（159 行）不共享实现，后者缺 runRecords/取消/批量/缩略图。已有 imageGenerationExecution.ts:34 的 withRunRecords 开关使复用可不改调用方。；并发无全局背压：queueStore.ts:58 concurrency=2 与 workflowEngine.ts:46 maxParallelNodes=3 互不知情，最多 5 路并发打同一 API Key。；取消不彻底：gemini.ts:136 与 gptImage.ts:175 仅在发起前检查 aborted，invoke 无 signal 透传，取消无法阻止在途请求继续（也无法阻止计费）。；API Key 明文落盘：settingsStore.ts:164 将含 apiKey 的 settings.providers 全量持久化到 app-data.json，全项目零加密。用户已授权改变数据格式并配套迁移。；依赖与构建收尾：bun.lock 与 package-lock.json 双锁文件并存（CI 与实际构建用 bun，package-lock.json 无人使用）；@types/uuid 已废弃且 uuid v13 自带类型。

**本轮暂缓**：用户反馈曾经“有卡顿的感觉”，但自称使用规模不大。静态阅读发现三处可疑点（flowStore.ts:482-490 每次 updateNodeData 全量重建 nodes；App.tsx:167-186 800ms 防抖整画布深拷贝 + canvasStore.partialize 遍历全部画布全部节点；config/prompts/ 5700+ 行静态文案全进主 bundle 且无 manualChunks），均未在真实运行中测量。；参考成熟产品做功能与 UI 优化（用户已提出，但要求先列计划、以问答确认后再实施）。；结构性问题（双画布两份真相、flowStore 巨型化、imageGeneratorConfig.ts 双向依赖）已被证据证实存在，但用户选择渐进路线且本轮不合并。

**阻塞**：无已记录阻塞

**下一步**：结合当前任务、验收与实际文件确定下一步

任务数量只描述已建立的工作；完整目标、尚未拆分需求和最终验收仍须核对。

## 未完成的上下文、决策与待办（Agent 笔记）

- 2026-09-28T02:20:11.233641Z · note/decision · 接入完成并 onboard 通过：integration.connected=true（isolated 布局，入口 WORKFLOW-KIT.md，状态 .workflow-kit/tasks/PROJECT.json，helper .workflow-kit/scripts/project_workflow.py，release 2026-09-21.1）。决策 DEC-7f39809752364169808eff26a48698a1 已记录。用户选择：refactor.intent=assess → 评估后选 incremental（渐进重构，先局部修补与去重）；执行方式=当前 Agent 仅作总控，代码编写与审查全部派发独立子代理，审查必须新开未参与实现的子代理（review_mode=independent_required）；允许改数据格式并配套迁移；允许本地提交并可推送到用户自己的 NextCreator 远程（严禁推 origin=MoonWeSif 上游）；允许增删依赖；交付目标=仅本机开发与运行；预算=推荐默认值（3 轮修复/180 分钟活动时间/每批 3 任务/单写入者/不自动续批）。
- 2026-09-28T02:20:16.173279Z · note/context · 基线事实（已实测）：(1) HEAD 已从 750e4fd 前进到 3bba554（本次接入提交，含 .workflow-kit/ 与三个规则入口；用户未提交的 .zcode/plans 删除保持原状未纳入）。(2) tsc --noEmit PASS（strict+noUnusedLocals 下零诊断）。(3) vite build 在本会话沙箱因 esbuild spawn EPERM 失败——这是沙箱对子进程管道 stdio 的限制，非项目缺陷，尚未在非沙箱 shell 验证。(4) cargo check 因 crates.io TLS 失败（SEC_E_NO_CREDENTIALS）且本地缓存缺 image crate 而 BLOCKED。(5) 本仓库有两个远程：origin=MoonWeSif/NextCreator（他人上游，main 当前跟踪它且 ahead 1）与 NextCreator=Dchean/NextCreator（用户自己的空仓库）。已设 git --local 身份 Dchean <2468193482@qq.com>。(6) 全项目 0 测试、0 lint；唯一 CI release.yml 仅 v* tag 触发。重要教训：会话初曾把提交 750e4fd 的 subject（本身就是一长串文件名）误读为'大量未提交改动'，实际工作区相对 HEAD 干净——判断 git 状态必须用 git status --porcelain 而非 git log 的输出。

## 教训

- 2026-09-28T02:23:40.443323Z · note/lesson · 关键可行性发现（总控已独立复现）：用 Node 24 原生 --experimental-strip-types + node:module registerHooks，可以在零新增依赖、零浏览器、零 Tauri 运行时的情况下直接加载并驱动 src/stores/queueStore.ts 的真实代码。实测输出：IMPORT OK；initial {jobs:0,concurrency:2}；enqueue->running；setConcurrency 钳制 1..4 正确。探针位置 .workflow-kit/tasks/evidence/probe-queue-store.mjs（命令：node --experimental-strip-types .workflow-kit/tasks/evidence/probe-queue-store.mjs，退出码 0）。所需 stub：@xyflow/react（必须在该层 stub，因为 react-dom 内部 CJS require 无法被 hook 拦截）、@tauri-apps/*、globalThis.window（tauriStorage.ts:100 顶层 window.addEventListener）、@/ 别名解析、无扩展名相对导入补 .ts。附带排除项：vitest 在本沙箱不可用，因为其转译依赖 esbuild JS API，而 esbuild 的 spawn 直接 EPERM（node_modules/esbuild/lib/main.js:1978）——与 vite build 失败同根因。另一发现：components/nodes/imageGeneratorConfig.ts 的前 3 个 import 全是 import type，运行时被完全擦除，故 queueStore 的运行时依赖链比静态阅读预期短很多。
- 2026-09-28T02:27:39.681566Z · note/lesson · REQ-001 根因定位（总控已独立复现，非推断）：queueStore.ts:209-212 的 partialize 过滤掉 running，而 queueStore.ts:213-228 的 onRehydrateStorage 恰好只查找 status===running 来标记'应用重启导致中断，可重试'。实测穷举 partialize 输出：queued,success,error,cancelled —— 恒不含 running，故该恢复分支是逻辑死代码，永不执行。这解释了为什么重启后任务不是卡在 running 而是永久卡在 queued：设计意图（重启→标记可重试的 error）被 partialize 的过滤悄悄取消。验证脚本 .workflow-kit/tasks/evidence/probe-partialize-deadbranch.mjs（退出码 0）同时证明：若不过滤 running，该分支能正确捕获 1 个任务（分支逻辑本身有效，只是输入恒空）。重要含义：这类 data-flow 不可达的死分支，knip/ts-prune 抓不到（只报未使用导出/文件），tsc 的 allowUnreachableCode 也抓不到（非语法不可达）——故为 REQ-003 引入死代码检测工具的性价比不足，已记录为 rejected。

## 最近事件

- 2026-09-28T02:16:42.733333Z · onboard · 已确认需求与执行方式；决定 DEC-7f39809752364169808eff26a48698a1；目标：为 NextCreator（可视化节点 AI 内容生成工作流桌面工具）建立可维护、稳定的继续演进基础，支持持续增加新节点与 AI 能力；本轮先做评估，不预设重构。
- 2026-09-28T02:20:11.233641Z · note/decision · 接入完成并 onboard 通过：integration.connected=true（isolated 布局，入口 WORKFLOW-KIT.md，状态 .workflow-kit/tasks/PROJECT.json，helper .workflow-kit/scripts/project_workflow.py，release 2026-09-21.1）。决策 DEC-7f39809752364169808eff26a48698a1 已记录。用户选择：refactor.intent=assess → 评估后选 incremental（渐进重构，先局部修补与去重）；执行方式=当前 Agent 仅作总控，代码编写与审查全部派发独立子代理，审查必须新开未参与实现的子代理（review_mode=independent_required）；允许改数据格式并配套迁移；允许本地提交并可推送到用户自己的 NextCreator 远程（严禁推 origin=MoonWeSif 上游）；允许增删依赖；交付目标=仅本机开发与运行；预算=推荐默认值（3 轮修复/180 分钟活动时间/每批 3 任务/单写入者/不自动续批）。
- 2026-09-28T02:20:16.173279Z · note/context · 基线事实（已实测）：(1) HEAD 已从 750e4fd 前进到 3bba554（本次接入提交，含 .workflow-kit/ 与三个规则入口；用户未提交的 .zcode/plans 删除保持原状未纳入）。(2) tsc --noEmit PASS（strict+noUnusedLocals 下零诊断）。(3) vite build 在本会话沙箱因 esbuild spawn EPERM 失败——这是沙箱对子进程管道 stdio 的限制，非项目缺陷，尚未在非沙箱 shell 验证。(4) cargo check 因 crates.io TLS 失败（SEC_E_NO_CREDENTIALS）且本地缓存缺 image crate 而 BLOCKED。(5) 本仓库有两个远程：origin=MoonWeSif/NextCreator（他人上游，main 当前跟踪它且 ahead 1）与 NextCreator=Dchean/NextCreator（用户自己的空仓库）。已设 git --local 身份 Dchean <2468193482@qq.com>。(6) 全项目 0 测试、0 lint；唯一 CI release.yml 仅 v* tag 触发。重要教训：会话初曾把提交 750e4fd 的 subject（本身就是一长串文件名）误读为'大量未提交改动'，实际工作区相对 HEAD 干净——判断 git 状态必须用 git status --porcelain 而非 git log 的输出。
- 2026-09-28T02:23:40.443323Z · note/lesson · 关键可行性发现（总控已独立复现）：用 Node 24 原生 --experimental-strip-types + node:module registerHooks，可以在零新增依赖、零浏览器、零 Tauri 运行时的情况下直接加载并驱动 src/stores/queueStore.ts 的真实代码。实测输出：IMPORT OK；initial {jobs:0,concurrency:2}；enqueue->running；setConcurrency 钳制 1..4 正确。探针位置 .workflow-kit/tasks/evidence/probe-queue-store.mjs（命令：node --experimental-strip-types .workflow-kit/tasks/evidence/probe-queue-store.mjs，退出码 0）。所需 stub：@xyflow/react（必须在该层 stub，因为 react-dom 内部 CJS require 无法被 hook 拦截）、@tauri-apps/*、globalThis.window（tauriStorage.ts:100 顶层 window.addEventListener）、@/ 别名解析、无扩展名相对导入补 .ts。附带排除项：vitest 在本沙箱不可用，因为其转译依赖 esbuild JS API，而 esbuild 的 spawn 直接 EPERM（node_modules/esbuild/lib/main.js:1978）——与 vite build 失败同根因。另一发现：components/nodes/imageGeneratorConfig.ts 的前 3 个 import 全是 import type，运行时被完全擦除，故 queueStore 的运行时依赖链比静态阅读预期短很多。
- 2026-09-28T02:23:44.318364Z · note/progress · REQ-001（重启后遗留 queued 任务永不执行）已从静态推断升级为可执行复现：探针模拟重启遗留 queued 任务后 250ms 无变化（仍为 queued），显式调用 pump() 后立即转为 error。证明缺失的调用就是启动时的 pump()，这是真实缺陷而非推断。该探针同时是 red->green 的候选回归证据：当前代码失败（卡在 queued），修复后应通过。
- 2026-09-28T02:27:04.121848Z · research · 参考调研状态 searched，候选 10 项：为第一批 A-D 四项改造检索可复用实现与真实约束：C 项需要 Tauri 2 的安全凭据存储方案；A 项需要可执行的验证门禁（本沙箱 vite/vitest 均不可用）；REQ-003 需要判断是否引入死代码检测工具。检索同时产出了两条改变结论的实测发现（partialize 死分支、零依赖 harness 可行）。
- 2026-09-28T02:27:39.681566Z · note/lesson · REQ-001 根因定位（总控已独立复现，非推断）：queueStore.ts:209-212 的 partialize 过滤掉 running，而 queueStore.ts:213-228 的 onRehydrateStorage 恰好只查找 status===running 来标记'应用重启导致中断，可重试'。实测穷举 partialize 输出：queued,success,error,cancelled —— 恒不含 running，故该恢复分支是逻辑死代码，永不执行。这解释了为什么重启后任务不是卡在 running 而是永久卡在 queued：设计意图（重启→标记可重试的 error）被 partialize 的过滤悄悄取消。验证脚本 .workflow-kit/tasks/evidence/probe-partialize-deadbranch.mjs（退出码 0）同时证明：若不过滤 running，该分支能正确捕获 1 个任务（分支逻辑本身有效，只是输入恒空）。重要含义：这类 data-flow 不可达的死分支，knip/ts-prune 抓不到（只报未使用导出/文件），tsc 的 allowUnreachableCode 也抓不到（非语法不可达）——故为 REQ-003 引入死代码检测工具的性价比不足，已记录为 rejected。
- 2026-09-28T02:34:09.661448Z · prepare · TASK-001 · 任务已冻结：queueStore 重启恢复与重复入队保护（含零依赖回归门禁）；范围 src/stores/queueStore.ts, src/hooks/useImageGeneratorExecution.ts, src/App.tsx, src/main.tsx, scripts, package.json

## 如何继续

1. 运行 resume；有 controller.lock 或 running 的 RUN 先核对进程，再决定 recover。
2. 阻塞任务先读任务卡的最近检查点和原始日志；scope/protocol/action_required/evidence 类阻塞用 `unblock --task --source --note` 带说明解锁，不新建任务。
3. 已确认但尚未拆分的需求见上表；只有全部需求关联到已验收任务并获用户确认才 `accept --project-complete`。
4. 完整日志：[JOURNAL.md](JOURNAL.md)；任务总览：[PROJECT_STATE.md](../tasks/PROJECT_STATE.md)。
