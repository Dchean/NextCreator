<!-- project-workflow: generated view; edit task JSON instead -->
# TASK-003 · 第一批 B 收口：统一图片执行链（REQ-004）、全局单一并发上限（REQ-005）、取消语义补全（REQ-006）

**状态**：done

**目标**：按已确认需求 REQ-004 / REQ-005 / REQ-006 做第一批 B 的收口改造：(1) 消除图片生成的两份执行链——工作流路径 nodeExecutor.executeImageGeneratorNode 改为复用唯一实现 executeImageGeneration（经既有 withRunRecords 开关保持调用方不变），使工作流路径同样获得运行记录、取消、批量与缩略图；(2) 建立全局单一并发上限——queueStore 的并发额度与 workflowEngine 的 maxParallelNodes 不再各自为政，图片生成的真正出口共用同一个许可源，超限请求排队而不是同时打同一 API Key；(3) 补全取消语义——取消后在结果返回处复查 aborted，阻止已返回的结果落盘与状态写入，并对无法真正中止在途请求的限制给出明确说明（不宣称已中止）。全部改动保持既有 UI 外观与交互、既有数据字段语义不变，并以既有零依赖门禁 + 新增覆盖证明无回归。

**依赖**：TASK-006, TASK-002
**参考方案**：REF-NODE-STRIP-TYPES
**界面约定**：不涉及界面
**界面检查**：不适用
**修改范围**：src/services/nodeExecutor.ts, src/services/imageGenerationExecution.ts, src/services/workflowEngine.ts, src/services/concurrencyLimiter.ts, src/services/imageGeneration/imageGenerationService.ts, src/services/imageGeneration/providers/gemini.ts, src/services/imageGeneration/providers/gptImage.ts, src/stores/queueStore.ts, scripts/queue-regression.mjs

## 验收标准

- REQ-004 单一实现入口：src/services/nodeExecutor.ts 的 executeImageGeneratorNode 不再自行拼装请求并分别调用 generateImage/editImage；它必须调用 src/services/imageGenerationExecution.ts 的 executeImageGeneration（工作流路径 withRunRecords 可为 true，使工作流执行也产生运行记录与缩略图）。判定：全仓 grep 确认 generateImage(/editImage( 的直接调用点只剩 src/services/imageGenerationExecution.ts 一处（imageGenerationService.ts 内部的 editImage→generateImage 转发除外）。
- REQ-004 行为一致：工作流路径的图片生成在成功时仍更新同一节点的 status/outputImage/outputImagePath/outputImages/outputImagePaths（既有节点渲染不变）；失败时仍返回 {success:false, error}，workflowEngine 的节点状态与下游 skip 行为不变。gate 用脚本无法覆盖 workflowEngine，必须以探针或实机验证并记录。
- REQ-004 不得改变工作流路径的既有可观察行为：nodeExecutor.executeNode 的返回结构（NodeExecutionResult）与 workflowEngine 对 result.success / result.error 的消费方式不变，不得因复用而让工作流路径开始写入 runRecords 之外的字段或改变节点 data 语义。
- REQ-005 单一并发上限：存在唯一可查询的全局并发额度来源（例如 src/services/concurrencyLimiter.ts 的 acquire/release 或等效 API），queueStore.pump() 与 workflowEngine.executeLayer() 都从它获取许可；二者不得各自持有互不知情的独立上限。
- REQ-005 超限排队：当图片生成的实际并发达到全局上限时，新增请求必须排队等待而不立即发起；判定：新增门禁用例证明「上限=1 时，两个不同节点同时请求生成，任一时刻实际在途调用数恒 ≤ 1，且第二个最终仍然执行」。
- REQ-005 UI 与语义自洽：QueuePanel 的并发数选择（1..4）仍是用户可设置的有效上限，但其语义变为「本节点队列向全局额度申请的份额上限」，不得让 UI 显示的并发数与实际可并发量不符；queueStore.concurrency 仍钳制在 1..4（queueStore.ts 现有 clamp 不变）。
- REQ-005 不得破坏 TASK-006 已闭合性质：同节点重复入队守卫（enqueue 内同步判定、整批原子、不看 paused、非全局单飞）、重启恢复、自愈订阅与零 churn 全部保持；既有 6 个门禁用例必须仍全部 PASS。
- REQ-006 返回后复查：取消（AbortSignal）后即使提供方已返回图片数据，也不得把结果写入节点状态或落盘；判定：新增门禁用例证明「signal 在请求返回前被 abort 时，节点 data 不出现新的成功产物（outputImage/outputImagePath/outputImages/outputImagePaths 不指向本次新图），且任务终态为 cancelled/error 而非 success」。
- REQ-006 明确说明限制：对「无法真正中止已发出的在途 HTTP 请求」给出明确说明，不得在任何注释、文档或提交信息中宣称已中止在途请求；只宣称「取消后不写回结果、不做后续落盘」。
- REQ-006 不得把取消做成静默丢弃：被取消的任务必须留下可观察的终态（cancelled 或 error 且有说明），不得让节点停在 loading 或 queued。
- node ./node_modules/typescript/bin/tsc --noEmit PASS（exit 0）；tsconfig.json 属受保护路径不得改动。
- node --experimental-strip-types scripts/queue-regression.mjs PASS（既有 6 用例全绿 + 本任务新增用例全绿），exit 0；不得为通过而弱化或删除既有断言（scripts/queue-regression.mjs 与其 selfcheck 属受保护路径）。
- node --experimental-strip-types scripts/queue-regression.selfcheck.mjs 保持可用（其针对未修复源码的红状态/变异体类断言在已修复源码上不制造新缺陷；不得改动该脚本）。
- 工作流路径复用后，真实应用仍可正常执行工作流图片节点与手动生成：以 release 构建 + CDP 实机验证（生成请求真的发出、节点状态按既有语义变化、取消后不写回结果），并把观察记录为证据。
- 不得扩大范围：不重构 flowStore/canvasStore 的双画布结构，不改 API Key 存储（属 REQ-007），不改 UI 外观与交互，不改画布或 app-data.json 既有字段含义。

## 测试适用性

- 既有行为：保持
- 原始基线：PASS；本任务为结构性收口（消除重复实现、统一并发额度、补全取消复查），不改变已验收的对外行为。原始基线：项目原本无任何自动化测试；TASK-005 交付的零依赖行为门禁（scripts/queue-regression.mjs，6 用例）已由 TASK-006 消费并通过五轮独立审查确认可用；TASK-006 与 TASK-002 验收后该门禁仍 6/6 PASS、exit 0（RUN-4f082949457846f1bdfc53b9ef9972b0，2026-09-29）。已知限制：门禁不 mount App、不驱动 workflowEngine，也不覆盖真实 IPC；这三项由本任务的实机验证补足。
- 基线证据：.workflow-kit/tasks/evidence/RUN-4f082949457846f1bdfc53b9ef9972b0-behavior-regression.stdout.txt
- 需求决定：DEC-execution-chain-unify
- 保留：scripts/queue-regression.mjs 的 6 个既有用例（A 重启恢复 / B-D 重复入队 / C 批量 / E 并发点击 / F retry）；这些用例保护的是 TASK-006 已验收的 REQ-001/REQ-002 行为，本任务明确要求保持；继续以同一命令同一判定标准运行。；验证：behavior-regression
- 补充：scripts/queue-regression.mjs 新增用例（全局并发上限、取消后不写回）；REQ-005 与 REQ-006 是本任务新覆盖的行为边界，既有 6 用例结构上抓不到：现有用例都在单节点且无全局额度竞争，也没有断言「取消后不落盘」。；验证：behavior-regression
- 保留：tsc --noEmit 类型门禁；唯一既有的静态门禁，strict + noUnusedLocals + noUnusedParameters 全开且当前零诊断；复用改造涉及跨文件签名，必须继续运行。；验证：typecheck

## 执行与恢复

- 首次开始：2026-09-29T10:01:49.787654Z
- 原截止时间：2026-09-29T13:01:49.787654Z
- 当前截止时间：2026-09-29T13:01:49.787654Z
- 时钟：按活动时间计：已用 55 分钟 / 额度 180 分钟（等待、断网和只读门禁不计）
- 已用修复轮：0
- 阻塞：无
- 下一步：继续已授权任务；所属功能完成后请用户验收

## 最近检查点

- 2026-09-29T11:00:02.251041Z：开始执行，保留原任务身份和截止时间；沿用本任务先前的范围基线，changed_files 为本任务累计改动；下一步：完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify
- 2026-09-29T11:00:03.817931Z：Worker requests manager action; inspect the result；下一步：处理执行者提出的请求，再 unblock 后 begin；不要新建任务或重置预算
- 2026-09-29T11:00:49.501185Z：阻塞已处置（action_required）：核对：① 该 run commands=0、无文件写入，改动仍为前序 run 留下的 6 个 in-scope 文件（diff --run 确认 6 in-scope、0 protected、0 outside）；② tsc exit 0、门禁 8/8 PASS exit 0 已在当前树复跑通过；③ 实机验证工作流路径 5/5 PASS 已完成；④ 已知项均已写入任务日志与 evidence，不会丢失。；下一步：begin 重新实现
- 2026-09-29T11:00:50.741897Z：开始执行，保留原任务身份和截止时间；沿用本任务先前的范围基线，changed_files 为本任务累计改动；下一步：完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify
- 2026-09-29T11:00:51.984030Z：编码结果已记录，差异范围已核对：无文件变化；下一步：运行 verify；代码完成尚未等于验收通过
- 2026-09-29T11:01:06.845947Z：预先定义的必需测试全部通过，日志已保存；下一步：审查当前候选；独立审查使用没有参与编码的新上下文
- 2026-09-29T11:40:18.136252Z：预先定义的必需测试全部通过，日志已保存；下一步：审查当前候选；独立审查使用没有参与编码的新上下文
- 2026-09-29T12:15:10.115552Z：当前候选的测试与审查通过（independent）；下一步：继续已授权任务；所属功能完成后请用户验收

## 原始证据

[唯一状态记录](../items/TASK-003.json)

- [RUN-b35dfb8808d64ed7bc3275ae7b0976bb](../runs/RUN-b35dfb8808d64ed7bc3275ae7b0976bb.json)
- [RUN-cfa6a30902594720bc7b139a0be8a2d3](../runs/RUN-cfa6a30902594720bc7b139a0be8a2d3.json)
- [RUN-521d1a09a82c4dbea5da62b06b936478](../runs/RUN-521d1a09a82c4dbea5da62b06b936478.json)
- [RUN-8f4fbdd0cc434d03a9f8e8187d8b6139](../runs/RUN-8f4fbdd0cc434d03a9f8e8187d8b6139.json)
- [RUN-f83dbba19d794cd89a0c2c5217afe8d5](../runs/RUN-f83dbba19d794cd89a0c2c5217afe8d5.json)
- [RUN-6981d2c3706741b5bcaa0201f5f170bf](../runs/RUN-6981d2c3706741b5bcaa0201f5f170bf.json)
- [RUN-852c12c4eafd4381ae91705c6ce1b19d](../runs/RUN-852c12c4eafd4381ae91705c6ce1b19d.json)
- [RUN-4606ff7583b54d729502a9139754eed3](../runs/RUN-4606ff7583b54d729502a9139754eed3.json)

卡片是自动生成的视图。Agent 修改任务记录、执行命令或保存检查点后重新生成；不手工把状态改成通过。
