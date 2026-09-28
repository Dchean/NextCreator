<!-- project-workflow: generated view; edit task JSON instead -->
# 项目状态

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

已建任务 4 项：已验收 0，待验收 0，阻塞 0。

| 任务 | 状态 | 目标 / 下一步 |
| --- | --- | --- |
| [TASK-006 · 修复 REQ-001 重启恢复与 REQ-002 重复入队保护（A 项收口，以 TASK-005 门禁验收）](<cards/TASK-006.md>) | 进行中 | 开始执行，保留原任务身份和截止时间；沿用本任务先前的范围基线，changed_files 为本任务累计改动；完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify |
| [TASK-001 · queueStore 重启恢复与重复入队保护（含零依赖回归门禁）](<cards/TASK-001.md>) | 已取消 | 任务已取消：总控 replan：拆分任务粒度。原 TASK-001 同时承担'搭建零依赖测试基础设施'与'修复两个业务缺陷'，连续两次派发（RUN-51a36a44、RUN-fd43e498）均因编码子代理上下文耗尽失败且业务源码零改动，属任务包过大而非偶发。现拆为 TASK-004（只交付门禁基础设施与红状态证据）与新 TASK-001（只做业务修复并以上述门禁验收）。本记录保留原任务身份、两次中断现场与 0 修复轮的时钟。；如需同一目标，准备新的任务并引用本任务作为历史 |
| [TASK-004 · 建立零依赖行为门禁基础设施（TS 加载器 + 队列回归脚本骨架）](<cards/TASK-004.md>) | 已取消 | 任务已取消：门禁规格含工具不支持的 expect_failure 字段，会致红状态门禁在 verify 时被误判为 FAIL。改为脚本自身提供 --expect-red 自检模式（红状态符合预期时退出码 0，意外变绿则非 0）。编码子代理的工作在修正后的新任务卡下继续，已产出的设计不受影响。；如需同一目标，准备新的任务并引用本任务作为历史 |
| [TASK-005 · 建立零依赖行为门禁基础设施（TS 加载器 + 队列回归脚本骨架）](<cards/TASK-005.md>) | 已取消 | 任务已取消：独立审查第 4、5 轮均判定 FAIL（均发现新的假绿路径：守卫位置不敏感/retry 旁路/自检空过；暂停态假绿/自检特异性不足/键名漂移）。用户决断收口：接受现门禁的可用能力，把 6 项已知缺口转为 TASK-006 的实现约束与人工回归清单，不再追加门禁修复轮。故本任务不予 verified/accept——审查结论保持 FAIL 记录，不追认为 PASS。交付物（scripts/queue-regression.mjs 与 selfcheck）保留在工作区并由 TASK-006 作为门禁直接消费；其能力已由五轮独立审查反复确认（含 r5 用自建 load-hook harness 确认用例 E/F 真实有效、旧断言仍承重、环境变量独立、键名白名单可靠）。；如需同一目标，准备新的任务并引用本任务作为历史 |

**已确认但尚未拆分的需求**：删除零引用死代码：imageService.ts（312 行）与 imageCompression.ts（81 行）共 393 行，全项目零外部 importer，而 tsc 在 noUnusedLocals 开启下仍 PASS，证明现有门禁抓不到整模块死代码。；执行链重复：手动路径 queueStore→imageGenerationExecution.ts（470 行）与工作流路径 workflowEngine:435→nodeExecutor.ts:390（159 行）不共享实现，后者缺 runRecords/取消/批量/缩略图。已有 imageGenerationExecution.ts:34 的 withRunRecords 开关使复用可不改调用方。；并发无全局背压：queueStore.ts:58 concurrency=2 与 workflowEngine.ts:46 maxParallelNodes=3 互不知情，最多 5 路并发打同一 API Key。；取消不彻底：gemini.ts:136 与 gptImage.ts:175 仅在发起前检查 aborted，invoke 无 signal 透传，取消无法阻止在途请求继续（也无法阻止计费）。；API Key 明文落盘：settingsStore.ts:164 将含 apiKey 的 settings.providers 全量持久化到 app-data.json，全项目零加密。用户已授权改变数据格式并配套迁移。；依赖与构建收尾：bun.lock 与 package-lock.json 双锁文件并存（CI 与实际构建用 bun，package-lock.json 无人使用）；@types/uuid 已废弃且 uuid v13 自带类型。

**本轮暂缓**：用户反馈曾经“有卡顿的感觉”，但自称使用规模不大。静态阅读发现三处可疑点（flowStore.ts:482-490 每次 updateNodeData 全量重建 nodes；App.tsx:167-186 800ms 防抖整画布深拷贝 + canvasStore.partialize 遍历全部画布全部节点；config/prompts/ 5700+ 行静态文案全进主 bundle 且无 manualChunks），均未在真实运行中测量。；参考成熟产品做功能与 UI 优化（用户已提出，但要求先列计划、以问答确认后再实施）。；结构性问题（双画布两份真相、flowStore 巨型化、imageGeneratorConfig.ts 双向依赖）已被证据证实存在，但用户选择渐进路线且本轮不合并。

**阻塞**：无已记录阻塞

**下一步**：结合当前任务、验收与实际文件确定下一步

任务数量只描述已建立的工作；完整目标、尚未拆分需求和最终验收仍须核对。

运行 `python .workflow-kit/scripts/project_workflow.py progress --root .` 生成对话用进度；start 给出实际下一步。
本文件由需求、PROJECT、任务和检查点生成；实际证据与进程仍须核对。
