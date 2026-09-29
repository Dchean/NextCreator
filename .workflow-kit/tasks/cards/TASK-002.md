<!-- project-workflow: generated view; edit task JSON instead -->
# TASK-002 · 删除零引用死代码与依赖收尾（REQ-003 + REQ-008：imageService/imageCompression、package-lock.json、@types/uuid）

**状态**：done

**目标**：按已确认需求 REQ-003 与 REQ-008 做纯删除型收尾：删除全项目零引用的死代码模块 src/services/imageService.ts 与 src/utils/imageCompression.ts（实测 357+95=452 行；需求描述中的 312+81=393 行是 2026-09-27 分析时的旧数字，已过期，以实测为准），删除无人使用的 package-lock.json（CI release.yml 与实际安装均用 bun），并从 package.json 与 bun.lock 移除已废弃的 @types/uuid（uuid v13 自带类型；uuid 本体保留）；以既有两条零依赖门禁证明无行为回归。

**依赖**：无
**参考方案**：见 ../RESEARCH.md
**界面约定**：不涉及界面
**界面检查**：不适用
**修改范围**：src/services/imageService.ts, src/utils/imageCompression.ts, package-lock.json, package.json, bun.lock

## 验收标准

- 实际改动恰为：删除 src/services/imageService.ts（357 行）、src/utils/imageCompression.ts（95 行）、package-lock.json 三个文件；package.json 移除 "@types/uuid" 一行；bun.lock 相应修剪 @types/uuid 条目。不得出现任何其他源码或配置改动。
- 删除后全仓（src/、scripts/、*.html、*.json、*.yml、*.toml，排除 node_modules 与 .workflow-kit）grep "imageService" 与 "imageCompression" 零命中。
- node ./node_modules/typescript/bin/tsc --noEmit PASS（exit 0）。编译选项不得改变（tsconfig.json 属保护路径）；该 PASS 同时证明移除 @types/uuid 后 uuid v13 自带类型解析正常。
- node --experimental-strip-types scripts/queue-regression.mjs 6/6 PASS 且 exit 0；不得修改该脚本及其 selfcheck。
- uuid 本体保留：package.json 依赖中 uuid 不动；src/stores/canvasStore.ts、src/stores/userPromptStore.ts、src/stores/flowStore.ts 的 import 不变（三者均属保护路径）。
- package-lock.json 删除不影响 CI：.github/workflows/release.yml 属保护路径，不得改动；其仅用 bun install，不引用 package-lock.json。
- bun.lock 修剪只允许 @types/uuid 相关条目消失。若 npx bun install 产生 @types/uuid 修剪以外的大范围变动（版本升级、整体重排、无关包增删），停止并报告，不得擅自接受。优先使用 npx --yes bun install --lockfile-only（不重写 node_modules）；若该 flag 不被当前 bun 版本支持，回退完整 npx --yes bun install 并逐行核对 git diff bun.lock。

## 测试适用性

- 既有行为：保持
- 原始基线：PASS；行为保持型任务：只删除零引用模块、未使用的 npm 锁文件与废弃类型包，不改变任何运行行为。基线=当前已验证候选（TASK-006，candidate_digest a0272c52…，其 10 个绑定文件哈希已于 2026-09-29 由总控全量重算复核、与当前工作树 src/ 一致）：typecheck 与 behavior-regression 两门禁在该 RUN 均 PASS（exit 0），总控当日亦在本树亲自复跑两门禁 PASS（tsc exit 0；queue-regression 6/6 PASS exit 0）。项目无其他旧测试套件需处置；两条门禁继续作为必需回归，本任务不替换、不退役任何检查。
- 基线证据：.workflow-kit/tasks/runs/RUN-abbaf27af8614605a132bc76cb7b4aae.json
- 需求决定：沿用既有行为，无新增业务取舍
- 保留：typecheck（tsc --noEmit）与 behavior-regression（queue-regression.mjs 6 用例）两条既有门禁；行为保持：既有门禁必须继续全 PASS，作为无回归证据；本任务无行为变更，无需替换或退役任何检查。；验证：typecheck, behavior-regression

## 执行与恢复

- 首次开始：2026-09-29T02:04:27.768223Z
- 原截止时间：2026-09-29T05:04:27.768223Z
- 当前截止时间：2026-09-29T05:04:27.768223Z
- 时钟：按活动时间计：已用 15 分钟 / 额度 180 分钟（等待、断网和只读门禁不计）
- 已用修复轮：0
- 阻塞：无
- 下一步：向用户展示成果并请求验收决定（TASK-006 与 TASK-002 均为已验证待验收）；提交/推送/tag 待用户指示

## 最近检查点

- 2026-09-29T02:04:27.843836Z：开始执行，保留原任务身份和截止时间；下一步：完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify
- 2026-09-29T02:20:21.930737Z：编码结果已记录，差异范围已核对：bun.lock, package-lock.json, package.json, src/services/imageService.ts, src/utils/imageCompression.ts；下一步：运行 verify；代码完成尚未等于验收通过
- 2026-09-29T02:20:43.101079Z：预先定义的必需测试全部通过，日志已保存；下一步：审查当前候选；独立审查使用没有参与编码的新上下文
- 2026-09-29T02:40:25.979147Z：当前候选的测试与审查通过（independent）；下一步：继续已授权任务；所属功能完成后请用户验收
- 2026-09-29T02:40:42.193750Z：TASK-002 完成收口：候选 fa249870c21d03b430686feaaa149a150ee83e888c8c09c5c13e2699bb2db23a（RUN-bf28ebb1 实现、RUN-fd785e43 验证：typecheck PASS exit 0 + behavior-regression 6/6 PASS exit 0）、独立审查 r1 PASS findings=[]（report-TASK-002-r1.json，全新上下文审查者重算 candidate digest、HEAD 级零引用证明、锁文件逐包依赖图核对、bun install --dry-run CI 一致性）。实际改动 5 路径：删除 imageService.ts(357行)/imageCompression.ts(95行)/package-lock.json(3712行)；package.json 移除 @types/uuid；bun.lock 纯删除修剪 175 行（@types/uuid + 先于本任务的失同步死条目 @google/genai、pptxgenjs 及传递子树，86 包 361→275，0 新增 0 版本变更）。总控裁定记录于 note（decision）。改动未提交，验收归用户。；下一步：向用户展示成果并请求验收决定（TASK-006 与 TASK-002 均为已验证待验收）；提交/推送/tag 待用户指示

## 原始证据

[唯一状态记录](../items/TASK-002.json)

- [RUN-bf28ebb10fb949fd9fc498048acc8d73](../runs/RUN-bf28ebb10fb949fd9fc498048acc8d73.json)
- [RUN-fd785e43b34047d09b11acdba86a9eb5](../runs/RUN-fd785e43b34047d09b11acdba86a9eb5.json)
- [RUN-0b27a8fe98ee4aabbdfe199500633500](../runs/RUN-0b27a8fe98ee4aabbdfe199500633500.json)

卡片是自动生成的视图。Agent 修改任务记录、执行命令或保存检查点后重新生成；不手工把状态改成通过。
