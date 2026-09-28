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

已建任务 3 项：已验收 0，待验收 0，阻塞 0。

| 任务 | 状态 | 目标 / 下一步 |
| --- | --- | --- |
| [TASK-005 · 建立零依赖行为门禁基础设施（TS 加载器 + 队列回归脚本骨架）](<../tasks/cards/TASK-005.md>) | 进行中 | 开始执行，保留原任务身份和截止时间；完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify |
| [TASK-001 · queueStore 重启恢复与重复入队保护（含零依赖回归门禁）](<../tasks/cards/TASK-001.md>) | 已取消 | 任务已取消：总控 replan：拆分任务粒度。原 TASK-001 同时承担'搭建零依赖测试基础设施'与'修复两个业务缺陷'，连续两次派发（RUN-51a36a44、RUN-fd43e498）均因编码子代理上下文耗尽失败且业务源码零改动，属任务包过大而非偶发。现拆为 TASK-004（只交付门禁基础设施与红状态证据）与新 TASK-001（只做业务修复并以上述门禁验收）。本记录保留原任务身份、两次中断现场与 0 修复轮的时钟。；如需同一目标，准备新的任务并引用本任务作为历史 |
| [TASK-004 · 建立零依赖行为门禁基础设施（TS 加载器 + 队列回归脚本骨架）](<../tasks/cards/TASK-004.md>) | 已取消 | 任务已取消：门禁规格含工具不支持的 expect_failure 字段，会致红状态门禁在 verify 时被误判为 FAIL。改为脚本自身提供 --expect-red 自检模式（红状态符合预期时退出码 0，意外变绿则非 0）。编码子代理的工作在修正后的新任务卡下继续，已产出的设计不受影响。；如需同一目标，准备新的任务并引用本任务作为历史 |

**已确认但尚未拆分的需求**：删除零引用死代码：imageService.ts（312 行）与 imageCompression.ts（81 行）共 393 行，全项目零外部 importer，而 tsc 在 noUnusedLocals 开启下仍 PASS，证明现有门禁抓不到整模块死代码。；执行链重复：手动路径 queueStore→imageGenerationExecution.ts（470 行）与工作流路径 workflowEngine:435→nodeExecutor.ts:390（159 行）不共享实现，后者缺 runRecords/取消/批量/缩略图。已有 imageGenerationExecution.ts:34 的 withRunRecords 开关使复用可不改调用方。；并发无全局背压：queueStore.ts:58 concurrency=2 与 workflowEngine.ts:46 maxParallelNodes=3 互不知情，最多 5 路并发打同一 API Key。；取消不彻底：gemini.ts:136 与 gptImage.ts:175 仅在发起前检查 aborted，invoke 无 signal 透传，取消无法阻止在途请求继续（也无法阻止计费）。；API Key 明文落盘：settingsStore.ts:164 将含 apiKey 的 settings.providers 全量持久化到 app-data.json，全项目零加密。用户已授权改变数据格式并配套迁移。；依赖与构建收尾：bun.lock 与 package-lock.json 双锁文件并存（CI 与实际构建用 bun，package-lock.json 无人使用）；@types/uuid 已废弃且 uuid v13 自带类型。

**本轮暂缓**：用户反馈曾经“有卡顿的感觉”，但自称使用规模不大。静态阅读发现三处可疑点（flowStore.ts:482-490 每次 updateNodeData 全量重建 nodes；App.tsx:167-186 800ms 防抖整画布深拷贝 + canvasStore.partialize 遍历全部画布全部节点；config/prompts/ 5700+ 行静态文案全进主 bundle 且无 manualChunks），均未在真实运行中测量。；参考成熟产品做功能与 UI 优化（用户已提出，但要求先列计划、以问答确认后再实施）。；结构性问题（双画布两份真相、flowStore 巨型化、imageGeneratorConfig.ts 双向依赖）已被证据证实存在，但用户选择渐进路线且本轮不合并。

**阻塞**：无已记录阻塞

**下一步**：结合当前任务、验收与实际文件确定下一步

任务数量只描述已建立的工作；完整目标、尚未拆分需求和最终验收仍须核对。

## 未完成的上下文、决策与待办（Agent 笔记）

- 2026-09-28T02:20:11.233641Z · note/decision · 接入完成并 onboard 通过：integration.connected=true（isolated 布局，入口 WORKFLOW-KIT.md，状态 .workflow-kit/tasks/PROJECT.json，helper .workflow-kit/scripts/project_workflow.py，release 2026-09-21.1）。决策 DEC-7f39809752364169808eff26a48698a1 已记录。用户选择：refactor.intent=assess → 评估后选 incremental（渐进重构，先局部修补与去重）；执行方式=当前 Agent 仅作总控，代码编写与审查全部派发独立子代理，审查必须新开未参与实现的子代理（review_mode=independent_required）；允许改数据格式并配套迁移；允许本地提交并可推送到用户自己的 NextCreator 远程（严禁推 origin=MoonWeSif 上游）；允许增删依赖；交付目标=仅本机开发与运行；预算=推荐默认值（3 轮修复/180 分钟活动时间/每批 3 任务/单写入者/不自动续批）。
- 2026-09-28T02:20:16.173279Z · note/context · 基线事实（已实测）：(1) HEAD 已从 750e4fd 前进到 3bba554（本次接入提交，含 .workflow-kit/ 与三个规则入口；用户未提交的 .zcode/plans 删除保持原状未纳入）。(2) tsc --noEmit PASS（strict+noUnusedLocals 下零诊断）。(3) vite build 在本会话沙箱因 esbuild spawn EPERM 失败——这是沙箱对子进程管道 stdio 的限制，非项目缺陷，尚未在非沙箱 shell 验证。(4) cargo check 因 crates.io TLS 失败（SEC_E_NO_CREDENTIALS）且本地缓存缺 image crate 而 BLOCKED。(5) 本仓库有两个远程：origin=MoonWeSif/NextCreator（他人上游，main 当前跟踪它且 ahead 1）与 NextCreator=Dchean/NextCreator（用户自己的空仓库）。已设 git --local 身份 Dchean <2468193482@qq.com>。(6) 全项目 0 测试、0 lint；唯一 CI release.yml 仅 v* tag 触发。重要教训：会话初曾把提交 750e4fd 的 subject（本身就是一长串文件名）误读为'大量未提交改动'，实际工作区相对 HEAD 干净——判断 git 状态必须用 git status --porcelain 而非 git log 的输出。
- 2026-09-28T03:02:27.966090Z · note/decision · 总控改换方案（RECOVERY 要求的 replan，非机械重试）：TASK-001 连续两次派发均因编码子代理上下文耗尽失败（RUN-51a36a44 与 RUN-fd43e498，两次业务源码均零改动）。失败模式相同且候选未变，说明问题在任务粒度而非偶发。结论：把原 TASK-001 拆成两张卡——TASK-000 只交付零依赖门禁基础设施（TS 加载器 + 队列回归脚本骨架 + 红状态证据），TASK-002 只做业务修复（REQ-001 重启恢复、REQ-002 重复入队保护）并以 TASK-000 的门禁为验收。理由：加载器含 4 条易错解析规则（@/ 别名、仅对 .ts 父模块补扩展名、必须 stub @xyflow/react 而非 react-dom、window stub），试错成本高；两次失败都消耗在'既要搭基础设施又要改业务'的复合目标上。拆分后每次派发的上下文需求显著下降，且 TASK-000 的门禁一旦固定，修复任务就变成可被自动验证的小改动。原 TASK-001 不再需要，按 cancel 处置并保留其记录，不新建同 ID 任务清零。

## 教训

- 2026-09-28T02:23:40.443323Z · note/lesson · 关键可行性发现（总控已独立复现）：用 Node 24 原生 --experimental-strip-types + node:module registerHooks，可以在零新增依赖、零浏览器、零 Tauri 运行时的情况下直接加载并驱动 src/stores/queueStore.ts 的真实代码。实测输出：IMPORT OK；initial {jobs:0,concurrency:2}；enqueue->running；setConcurrency 钳制 1..4 正确。探针位置 .workflow-kit/tasks/evidence/probe-queue-store.mjs（命令：node --experimental-strip-types .workflow-kit/tasks/evidence/probe-queue-store.mjs，退出码 0）。所需 stub：@xyflow/react（必须在该层 stub，因为 react-dom 内部 CJS require 无法被 hook 拦截）、@tauri-apps/*、globalThis.window（tauriStorage.ts:100 顶层 window.addEventListener）、@/ 别名解析、无扩展名相对导入补 .ts。附带排除项：vitest 在本沙箱不可用，因为其转译依赖 esbuild JS API，而 esbuild 的 spawn 直接 EPERM（node_modules/esbuild/lib/main.js:1978）——与 vite build 失败同根因。另一发现：components/nodes/imageGeneratorConfig.ts 的前 3 个 import 全是 import type，运行时被完全擦除，故 queueStore 的运行时依赖链比静态阅读预期短很多。
- 2026-09-28T02:27:39.681566Z · note/lesson · REQ-001 根因定位（总控已独立复现，非推断）：queueStore.ts:209-212 的 partialize 过滤掉 running，而 queueStore.ts:213-228 的 onRehydrateStorage 恰好只查找 status===running 来标记'应用重启导致中断，可重试'。实测穷举 partialize 输出：queued,success,error,cancelled —— 恒不含 running，故该恢复分支是逻辑死代码，永不执行。这解释了为什么重启后任务不是卡在 running 而是永久卡在 queued：设计意图（重启→标记可重试的 error）被 partialize 的过滤悄悄取消。验证脚本 .workflow-kit/tasks/evidence/probe-partialize-deadbranch.mjs（退出码 0）同时证明：若不过滤 running，该分支能正确捕获 1 个任务（分支逻辑本身有效，只是输入恒空）。重要含义：这类 data-flow 不可达的死分支，knip/ts-prune 抓不到（只报未使用导出/文件），tsc 的 allowUnreachableCode 也抓不到（非语法不可达）——故为 REQ-003 引入死代码检测工具的性价比不足，已记录为 rejected。
- 2026-09-28T02:49:22.045857Z · note/lesson · 调度教训：TASK-001 首次派发的编码子代理因上下文耗尽退出，零改动（RUN-51a36a44aa3b40b99784d9949cd2d093，commands=0）。原因分析：我给单个子代理的任务包过大——要求它同时完成 (a) 通读并理解 queueStore 的 partialize/rehydrate 死分支细节、(b) 处理画布加载竞态与崩溃循环、(c) 新建一个含 4 条易错解析规则的 Node loader、(d) 写两个用例、(e) 先跑红再跑绿并记录原始输出。其中 (c) 尤其昂贵，因为 loader 的四个阻碍（@/ 别名、仅在 .ts 父模块补扩展名、必须 stub @xyflow/react 而非 react-dom、window stub）都需要反复试错才能收敛。改进措施：把 loader 基础设施与业务修复拆成两张卡——先单独交付可复用的 harness（TASK-001），再在其上做业务修复（新任务）。同时把总控已验证的探针作为起点直接提供给编写者，减少重复试错。处置依据：RECOVERY 的 interrupted 出口，已用 recover + unblock 接续原任务，修复轮使用 0、原时钟保留，未新建任务清零。
- 2026-09-28T03:01:47.203052Z · note/lesson · 重大技术突破（来自编码子代理 #2 的遗留 spike，总控已独立运行验证并固化）：可以用 react-dom/server 的 renderToStaticMarkup 在纯 Node 中驱动**真实的 React hook** useImageGeneratorExecution，从而无需 jsdom、无需浏览器就能测试 handleGenerate 的真实入队行为。已验证输出：mounted, handle type: function；jobs after first generate: 1。这比总控原先的探针覆盖面更大——原探针只能驱动 store 方法，现在能驱动 hook 层真实逻辑。固化为 .workflow-kit/tasks/evidence/probe-dup-enqueue.mjs。
- 2026-09-28T03:04:59.712494Z · note/lesson · 工具约束教训（总控自查发现）：任务卡 gates 不支持 expect_failure 字段。我原以为可以用它表达'这个红状态门禁预期失败'，但 workflow_runtime/project_workflow 的校验逻辑只认 program/args/cwd/required/reason/timeout_seconds，未知字段被忽略；verify 只按 exit_code==0 判 PASS，因此红状态脚本会永远 FAIL 并把任务卡死。正确做法：把'预期红'下沉到脚本自身的 --expect-red 自检模式（红状态符合预期时退出码 0，意外变绿则非 0），门禁命令本身始终要求退出码 0。教训推广：给门禁写'预期失败'这类语义前，必须先确认工具的校验与判定实现，而不是假设字段被支持。

## 最近事件

- 2026-09-28T03:01:47.399580Z · note/progress · REQ-002 已从静态推断升级为可执行红状态证明（探针 probe-dup-enqueue.mjs，退出码 1 = 符合预期的红）：同一节点连续调用三次真实 handleGenerate，活动 job 数依次为 1 → 2 → 3（状态分别 running / queued,running / queued,queued,running）。即连点会创建 N 个并发任务写同一 node.data，证实 useImageGeneratorExecution.ts:62 前后无任何重复入队保护。该探针同时是可用的红→绿回归证据：修复后应恒为 1。
- 2026-09-28T03:02:27.966090Z · note/decision · 总控改换方案（RECOVERY 要求的 replan，非机械重试）：TASK-001 连续两次派发均因编码子代理上下文耗尽失败（RUN-51a36a44 与 RUN-fd43e498，两次业务源码均零改动）。失败模式相同且候选未变，说明问题在任务粒度而非偶发。结论：把原 TASK-001 拆成两张卡——TASK-000 只交付零依赖门禁基础设施（TS 加载器 + 队列回归脚本骨架 + 红状态证据），TASK-002 只做业务修复（REQ-001 重启恢复、REQ-002 重复入队保护）并以 TASK-000 的门禁为验收。理由：加载器含 4 条易错解析规则（@/ 别名、仅对 .ts 父模块补扩展名、必须 stub @xyflow/react 而非 react-dom、window stub），试错成本高；两次失败都消耗在'既要搭基础设施又要改业务'的复合目标上。拆分后每次派发的上下文需求显著下降，且 TASK-000 的门禁一旦固定，修复任务就变成可被自动验证的小改动。原 TASK-001 不再需要，按 cancel 处置并保留其记录，不新建同 ID 任务清零。
- 2026-09-28T03:03:10.970609Z · checkpoint · TASK-001 · 任务已取消：总控 replan：拆分任务粒度。原 TASK-001 同时承担'搭建零依赖测试基础设施'与'修复两个业务缺陷'，连续两次派发（RUN-51a36a44、RUN-fd43e498）均因编码子代理上下文耗尽失败且业务源码零改动，属任务包过大而非偶发。现拆为 TASK-004（只交付门禁基础设施与红状态证据）与新 TASK-001（只做业务修复并以上述门禁验收）。本记录保留原任务身份、两次中断现场与 0 修复轮的时钟。；下一步：如需同一目标，准备新的任务并引用本任务作为历史
- 2026-09-28T03:03:11.010727Z · cancel · TASK-001 · 总控 replan：拆分任务粒度。原 TASK-001 同时承担'搭建零依赖测试基础设施'与'修复两个业务缺陷'，连续两次派发（RUN-51a36a44、RUN-fd43e498）均因编码子代理上下文耗尽失败且业务源码零改动，属任务包过大而非偶发。现拆为 TASK-004（只交付门禁基础设施与红状态证据）与新 TASK-001（只做业务修复并以上述门禁验收）。本记录保留原任务身份、两次中断现场与 0 修复轮的时钟。；依据：总控依据 RECOVERY 的 replan 要求改换方案（相同失败且候选未变时不得机械重试）
- 2026-09-28T03:03:15.395015Z · prepare · TASK-004 · 任务已冻结：建立零依赖行为门禁基础设施（TS 加载器 + 队列回归脚本骨架）；范围 scripts, package.json
- 2026-09-28T03:03:20.705628Z · checkpoint · TASK-004 · 开始执行，保留原任务身份和截止时间；下一步：完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify
- 2026-09-28T03:04:28.298296Z · checkpoint · TASK-004 · Interrupted run recovered: 总控核对：门禁规格存在工具不支持字段（expect_failure），在 verify 阶段会把红状态门禁判为 FAIL 而使任务阻塞。总控于编码子代理开始落盘前中断其工作（已确认 scripts/ 与 package.json 均无改动，deliverable 不存在），故本次运行无候选、无副作用，可安全关闭。将重新准备带 --expect-red 自检模式的正确任务定义。；下一步：先核对已有文件及原始日志，再处理 interrupted；不要新建任务或重置预算
- 2026-09-28T03:04:32.929356Z · checkpoint · TASK-004 · 任务已取消：门禁规格含工具不支持的 expect_failure 字段，会致红状态门禁在 verify 时被误判为 FAIL。改为脚本自身提供 --expect-red 自检模式（红状态符合预期时退出码 0，意外变绿则非 0）。编码子代理的工作在修正后的新任务卡下继续，已产出的设计不受影响。；下一步：如需同一目标，准备新的任务并引用本任务作为历史
- 2026-09-28T03:04:32.956991Z · cancel · TASK-004 · 门禁规格含工具不支持的 expect_failure 字段，会致红状态门禁在 verify 时被误判为 FAIL。改为脚本自身提供 --expect-red 自检模式（红状态符合预期时退出码 0，意外变绿则非 0）。编码子代理的工作在修正后的新任务卡下继续，已产出的设计不受影响。；依据：总控实际读取 workflow_runtime.py 的任务定义校验与 verify 逻辑后作出的技术更正
- 2026-09-28T03:04:42.768632Z · prepare · TASK-005 · 任务已冻结：建立零依赖行为门禁基础设施（TS 加载器 + 队列回归脚本骨架）；范围 scripts, package.json
- 2026-09-28T03:04:49.103869Z · checkpoint · TASK-005 · 开始执行，保留原任务身份和截止时间；下一步：完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify
- 2026-09-28T03:04:59.712494Z · note/lesson · 工具约束教训（总控自查发现）：任务卡 gates 不支持 expect_failure 字段。我原以为可以用它表达'这个红状态门禁预期失败'，但 workflow_runtime/project_workflow 的校验逻辑只认 program/args/cwd/required/reason/timeout_seconds，未知字段被忽略；verify 只按 exit_code==0 判 PASS，因此红状态脚本会永远 FAIL 并把任务卡死。正确做法：把'预期红'下沉到脚本自身的 --expect-red 自检模式（红状态符合预期时退出码 0，意外变绿则非 0），门禁命令本身始终要求退出码 0。教训推广：给门禁写'预期失败'这类语义前，必须先确认工具的校验与判定实现，而不是假设字段被支持。

## 如何继续

1. 运行 resume；有 controller.lock 或 running 的 RUN 先核对进程，再决定 recover。
2. 阻塞任务先读任务卡的最近检查点和原始日志；scope/protocol/action_required/evidence 类阻塞用 `unblock --task --source --note` 带说明解锁，不新建任务。
3. 已确认但尚未拆分的需求见上表；只有全部需求关联到已验收任务并获用户确认才 `accept --project-complete`。
4. 完整日志：[JOURNAL.md](JOURNAL.md)；任务总览：[PROJECT_STATE.md](../tasks/PROJECT_STATE.md)。
