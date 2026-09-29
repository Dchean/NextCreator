<!-- project-workflow: generated view; edit task JSON instead -->
# TASK-006 · 修复 REQ-001 重启恢复与 REQ-002 重复入队保护（A 项收口，以 TASK-005 门禁验收）

**状态**：done

**目标**：修复 REQ-001（应用重启后遗留的 queued 任务永不执行、相关节点永久显示“排队中”并禁用生成）与 REQ-002（缺少同一节点的重复入队保护），并建立一份零新增依赖的行为回归门禁，使这两项缺陷有可执行的红→绿证据。

**依赖**：无
**参考方案**：REF-NODE-STRIP-TYPES
**界面约定**：不涉及界面
**界面检查**：不适用
**修改范围**：src/stores/queueStore.ts, src/hooks/useImageGeneratorExecution.ts, src/App.tsx, src/main.tsx

## 验收标准

- REQ-001：应用重启（store 重新水合）后，持久化下来的 queued 任务得到明确处置，不再永久停留在 queued。已确认行为按 DEC-restart-queue-resume：自动恢复并继续生成（会产生真实 API 费用，用户已明确接受）。
- REQ-001 根因处理：queueStore.ts:209-212 的 partialize 过滤掉 running，而 :213-228 的 onRehydrateStorage 只查找 running，导致该恢复分支恒不可达（已实测穷举证明）。必须使 partialize 与恢复逻辑意图自洽，硬性要求：不允许留下仍然不可达的分支。
- REQ-001 竞态：恢复不得早于画布数据就绪导致任务因“节点不存在”失败（imageGenerationExecution 会返回该错误）；必须处理该顺序竞态，使缺陷不以新形式复现。
- REQ-001 防崩溃循环：若应用在恢复后立即崩溃，不得无限反复重试；需有次数或状态约束。
- REQ-001 节点锁死解除：处置完成后，相关节点不再被 data.queued 永久锁死（ImageGeneratorNode.tsx:215 的 canRun）。
- REQ-002：同一节点已有 queued 或 running 任务时，再次触发生成不再产生并发任务。注意不得误伤批量拆分（batchCount > 1 时 useImageGeneratorExecution.ts:61-74 会连续 enqueue 多个 job）。
- 必须实际运行 TASK-000 交付的门禁 node --experimental-strip-types scripts/queue-regression.mjs，并记录修复后的通过输出；同时引用 TASK-000 记录的修复前失败输出，形成红→绿证据。
- 不得通过修改 scripts/queue-regression.mjs 的断言来使结果通过；若某断言与需求冲突，停止并报告。
- 保持 concurrency 钳制 1..4（queueStore.ts:112）与现有取消语义不变。
- node ./node_modules/typescript/bin/tsc --noEmit 保持 PASS。不改 UI 外观与交互；不改节点数据字段语义；不改画布或 app-data.json 既有字段含义。
- 去重必须覆盖 queued 与 running 两种活动状态，且必须按「用户点击」粒度判定、只对活动任务生效：既不得拦掉同一次点击内的合法批量 job（batchCount>1，useImageGeneratorExecution.ts:61-74），也不得因历史 job 锁死节点重生成。禁止写成仅判定 running（历史上 taskManager.isTaskRunning 即为该形态，会导致同节点在额度占满时累积多个 queued 任务后并发派发）。
- 禁止全局单飞守卫（不按 nodeId 区分、任何节点有活动 job 即拒绝入队），这会禁止不同节点并发生成，与 queueStore 的 concurrency 1..4 设计冲突。
- 启动恢复必须落在 store 层（如 onRehydrateStorage）：门禁用例 A 只驱动 store 水合链路、不 mount App，实现在 App.tsx 的 useEffect 会被判红；且恢复须同时清除节点的 data.queued 标记，否则用户仍看到按钮禁用与“排队中”。
- 【门禁已知缺口转为实现约束】门禁经五轮独立审查，确认存在 6 项未被自动覆盖的形态；实现必须逐条规避，不得依赖门禁代替判断：(a) 暂停态——守卫不得在 queueStore.paused 为真时跳过判定（暂停时生成按钮仍可点，data.queued 在首个 await 之后才写，连点会累积并发任务）；(b) 守卫必须放在 queueStore.enqueue 内同步判定，不得只放 handleGenerate 入口（否则重叠点击与 retry 两条路径都能绕过）；(c) 必须按「用户点击」整批原子判定，不得逐个 job 判重（否则批量拆分被截断为 1）；(d) 只判定该节点的活动任务（queued||running），不得对历史任务判重（否则锁死重试与重生成）；(e) 不得写成「仅判定 running」（历史 taskManager.isTaskRunning 即该形态）；(f) 不得写成全局单飞（不按 nodeId 区分）。
- 【必须由用户实机确认，不得仅以门禁通过为完成依据】门禁未覆盖暂停态等场景（见上）。交付时总控须提供具体手动验证步骤清单，至少覆盖四个场景：快速连点同一节点、批量 n>1 生成、队列暂停状态下的连点、应用重启后的遗留任务处置。由用户实际启动应用逐项确认。
- 门禁脚本（scripts/queue-regression.mjs 与 selfcheck）属受保护路径：实现者不得修改、弱化或绕过它们来使结果通过；若发现门禁断言与需求冲突，停止并报告。

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

- 首次开始：2026-09-28T06:24:59.726013Z
- 原截止时间：2026-09-28T09:24:59.726013Z
- 当前截止时间：2026-10-01T00:15:54.452842Z
- 时钟：按活动时间计：已用 250 分钟 / 额度 3335 分钟（等待、断网和只读门禁不计）
- 已用修复轮：9
- 阻塞：无
- 下一步：继续已授权任务；所属功能完成后请用户验收

## 最近检查点

- 2026-09-29T06:09:54.483179Z：CDP 实机验收 7/7 场景全部通过（用户指令：实机验收交由你cdp实机检测；总控执行）。环境：cargo release 构建（含 HEAD 全部修复，dist 重建后重新嵌入）+ vite devUrl + WebView2 CDP 9222，测试画布隔离用户数据（app-data.json 预先备份、测试后已恢复）。逐场景证据存 .workflow-kit/tasks/evidence/TASK-006-manual-verify/（00-17 共 17 张截图+记录）：S1 连点3次→仅1任务(节点解锁)；S2 Gemini n=4 两轮各完整4个(队列面板示 1/4..4/4,不因历史任务锁死)；S3 暂停态三连点→仅1个queued(截图08)、恢复后仅执行该1个；S4 error任务重试按钮连点3次→仅1个新活动任务(14→15)；S5 强杀进程重启→遗留queued自动恢复并真实执行(有startedAt/finishedAt+502错误信息)、节点解锁、无崩溃循环；S6 暂停→排队→加节点→取消→Ctrl+Z/Ctrl+Y→陈旧排队标记零复活(nodeQueued=false,截图13/14)；S7 被拒点击toast确认(哨兵80ms轮询:点击后70ms出现文案「该节点仍有任务在排队中，本次点击未生效（可等待完成或用队列面板取消）」持续约3秒、total恒53零新增；同上下文400ms复验在场)。S5(d)节点不存在的变体未构造，如实记录。测试期间任务失败均为本地网关502(用户自身配置,无外部费用)。新发现(独立于本任务):dev profile构建的WebView2浏览器进程启动即崩(msedge.dll 0x80000003,窗口白屏);release构建与已安装v0.2.6正常——已用release完成全部验收,该问题留待后续任务排查。用户数据已恢复原状(备份回写,EBWebView配置目录同步恢复),测试供应商/画布2/任务记录全部清除。；下一步：以用户委托原话执行 accept TASK-006；TASK-002 仍待用户验收决定；TASK-002 的 5 处未提交改动待用户指示提交/推送
- 2026-09-29T06:10:38.954142Z：预先定义的必需测试全部通过，日志已保存；下一步：审查当前候选；独立审查使用没有参与编码的新上下文
- 2026-09-29T06:36:41.497058Z：Review requires changes; inspect the findings；下一步：先核对已有文件及原始日志，再处理 review_failure；不要新建任务或重置预算
- 2026-09-29T06:39:33.928008Z：阻塞已处置（review_failure）：verification RUN-984b00f8（两门禁 PASS）与候选 26b2276c 完好未动；待 r13 独立确认审查（findings 应为空——3 条记录性事项已分别落为 evidence 文件或属简报口径）后记录 review 并 accept；下一步：begin 重新实现
- 2026-09-29T06:40:17.892220Z：开始执行，保留原任务身份和截止时间；下一步：完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify
- 2026-09-29T06:40:32.666409Z：编码结果已记录，差异范围已核对：无文件变化；下一步：运行 verify；代码完成尚未等于验收通过
- 2026-09-29T06:40:45.557182Z：预先定义的必需测试全部通过，日志已保存；下一步：审查当前候选；独立审查使用没有参与编码的新上下文
- 2026-09-29T07:00:57.040359Z：当前候选的测试与审查通过（independent）；下一步：继续已授权任务；所属功能完成后请用户验收

## 原始证据

[唯一状态记录](../items/TASK-006.json)

- [RUN-0aa58b4b10944472990efaef53e574f4](../runs/RUN-0aa58b4b10944472990efaef53e574f4.json)
- [RUN-91fb3b24f5794c2b8a01c383044be8dd](../runs/RUN-91fb3b24f5794c2b8a01c383044be8dd.json)
- [RUN-aec32fac61174c848c35fe4cd52a8e32](../runs/RUN-aec32fac61174c848c35fe4cd52a8e32.json)
- [RUN-91b31552313e494a93fb7b830bd2efe9](../runs/RUN-91b31552313e494a93fb7b830bd2efe9.json)
- [RUN-b993e0a8bf114540b928219a986f65a7](../runs/RUN-b993e0a8bf114540b928219a986f65a7.json)
- [RUN-b46fc7ad1ea44a9288670196c6cdebb1](../runs/RUN-b46fc7ad1ea44a9288670196c6cdebb1.json)
- [RUN-c2ba8c81ae33415b86da5a69773ce83e](../runs/RUN-c2ba8c81ae33415b86da5a69773ce83e.json)
- [RUN-ac04e620492e43a9b51fe890da6c4e4c](../runs/RUN-ac04e620492e43a9b51fe890da6c4e4c.json)
- [RUN-365a88f543cc472e8bf6faa479d069a6](../runs/RUN-365a88f543cc472e8bf6faa479d069a6.json)
- [RUN-8956d5d1afd849958ae34dff4633c4a0](../runs/RUN-8956d5d1afd849958ae34dff4633c4a0.json)
- [RUN-f1967f3c03794e1ebd2570263fd57850](../runs/RUN-f1967f3c03794e1ebd2570263fd57850.json)
- [RUN-e9d33ed7705e4c1c958875018a710480](../runs/RUN-e9d33ed7705e4c1c958875018a710480.json)
- [RUN-e0bd69e2a5e84f5fb544f6e3c8c77572](../runs/RUN-e0bd69e2a5e84f5fb544f6e3c8c77572.json)
- [RUN-f743ec046a6e4958af6529925fe1b129](../runs/RUN-f743ec046a6e4958af6529925fe1b129.json)
- [RUN-76cdf207e8c24ef08572a2bb94b2882d](../runs/RUN-76cdf207e8c24ef08572a2bb94b2882d.json)
- [RUN-e941e48cfbfd4f07933019a1932bfca8](../runs/RUN-e941e48cfbfd4f07933019a1932bfca8.json)
- [RUN-7801e633680d4486897b42c854759b99](../runs/RUN-7801e633680d4486897b42c854759b99.json)
- [RUN-b5b080dd4a174fa78c0bfb626659b9b7](../runs/RUN-b5b080dd4a174fa78c0bfb626659b9b7.json)
- [RUN-b8635b7958134b5e85f58c45e5ec0b19](../runs/RUN-b8635b7958134b5e85f58c45e5ec0b19.json)
- [RUN-35beb9f3089449c0afba93c8529dc107](../runs/RUN-35beb9f3089449c0afba93c8529dc107.json)
- [RUN-16747aa77a504e4a80e021422ac5be5d](../runs/RUN-16747aa77a504e4a80e021422ac5be5d.json)
- [RUN-f578b371e4ca4745b3ab5f247803136b](../runs/RUN-f578b371e4ca4745b3ab5f247803136b.json)
- [RUN-f1989c3509f5446fabb4a6ee38392db8](../runs/RUN-f1989c3509f5446fabb4a6ee38392db8.json)
- [RUN-e47f10027ac54a3d9a3bf392e79356b9](../runs/RUN-e47f10027ac54a3d9a3bf392e79356b9.json)
- [RUN-06d6f04858c94beabcca1ea72a7e7062](../runs/RUN-06d6f04858c94beabcca1ea72a7e7062.json)
- [RUN-27b991ac86e24e7fb5d2d54fe4cfde4d](../runs/RUN-27b991ac86e24e7fb5d2d54fe4cfde4d.json)
- [RUN-19101ba9138542049e38500aad3b5c63](../runs/RUN-19101ba9138542049e38500aad3b5c63.json)
- [RUN-1b4066e469e74547a148809ae2aa689c](../runs/RUN-1b4066e469e74547a148809ae2aa689c.json)
- [RUN-a4f7128d1c714343bdf14498955028d4](../runs/RUN-a4f7128d1c714343bdf14498955028d4.json)
- [RUN-6448242260e945379b5d9410582dc79b](../runs/RUN-6448242260e945379b5d9410582dc79b.json)
- [RUN-b8fb023eed4b4153982600d8d1eea207](../runs/RUN-b8fb023eed4b4153982600d8d1eea207.json)
- [RUN-9a2827e09045460194bbe0d50f99f481](../runs/RUN-9a2827e09045460194bbe0d50f99f481.json)
- [RUN-7620fe743b1b494d9e500c8e0687e35f](../runs/RUN-7620fe743b1b494d9e500c8e0687e35f.json)
- [RUN-ea6abe1f1d2545238089f8b609781df8](../runs/RUN-ea6abe1f1d2545238089f8b609781df8.json)
- [RUN-18de4b402836488a8054a1424794a1f5](../runs/RUN-18de4b402836488a8054a1424794a1f5.json)
- [RUN-5d57d1e057ba4cba94c0b520d5cbe60e](../runs/RUN-5d57d1e057ba4cba94c0b520d5cbe60e.json)
- [RUN-48b9bcc879c44c7d9a5ac0ce076cf409](../runs/RUN-48b9bcc879c44c7d9a5ac0ce076cf409.json)
- [RUN-08ea6aa5677c461495265159cf50dec2](../runs/RUN-08ea6aa5677c461495265159cf50dec2.json)
- [RUN-3ae83f35e6044115b0347c269ec2d43c](../runs/RUN-3ae83f35e6044115b0347c269ec2d43c.json)
- [RUN-abbaf27af8614605a132bc76cb7b4aae](../runs/RUN-abbaf27af8614605a132bc76cb7b4aae.json)
- [RUN-0410f4e5577240b2946212af8c4bc7e5](../runs/RUN-0410f4e5577240b2946212af8c4bc7e5.json)
- [RUN-984b00f86895447a94a45d2f3488a772](../runs/RUN-984b00f86895447a94a45d2f3488a772.json)
- [RUN-88fc6a6ea0e34b3bb36d5b9799a88dc7](../runs/RUN-88fc6a6ea0e34b3bb36d5b9799a88dc7.json)
- [RUN-387cc0d7d9d94e5394546cb331baeb0a](../runs/RUN-387cc0d7d9d94e5394546cb331baeb0a.json)
- [RUN-4f082949457846f1bdfc53b9ef9972b0](../runs/RUN-4f082949457846f1bdfc53b9ef9972b0.json)
- [RUN-2e6fce8353c942eca003fe510b2d3387](../runs/RUN-2e6fce8353c942eca003fe510b2d3387.json)

卡片是自动生成的视图。Agent 修改任务记录、执行命令或保存检查点后重新生成；不手工把状态改成通过。
