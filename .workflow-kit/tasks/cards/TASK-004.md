<!-- project-workflow: generated view; edit task JSON instead -->
# TASK-004 · 建立零依赖行为门禁基础设施（TS 加载器 + 队列回归脚本骨架）

**状态**：cancelled

**目标**：为项目建立一份可复用的零新增依赖行为测试基础设施：一个能加载真实 src/**/*.ts 的 Node 加载器，以及在其上运行的队列回归脚本骨架（含两个用例的红状态断言）。本任务只交付基础设施与红状态证据，不修复任何业务缺陷——业务修复由后续任务在本门禁之上进行。

**依赖**：无
**参考方案**：REF-NODE-STRIP-TYPES
**界面约定**：不涉及界面
**界面检查**：不适用
**修改范围**：scripts, package.json

## 验收标准

- 新增 scripts/queue-regression.mjs，可通过 `node --experimental-strip-types scripts/queue-regression.mjs` 运行，退出码语义为：全部用例通过 0，任一失败非 0。
- 脚本必须加载并驱动真实 src 代码，不得复制或重新实现被测逻辑。允许 stub 外部边界（@xyflow/react、@tauri-apps/*），但被测的 queueStore 与 useImageGeneratorExecution 必须是真实实现。
- 包含两个用例：(A) 重启恢复——持久化中存在 queued 任务，经水合/启动后断言该任务不再停留 queued；(B) 重复入队——同一节点连续触发生成，断言活动任务数不增长。
- 两个用例的断言对象必须是需求描述的可观察行为，不得断言内部变量、私有函数或调用顺序。
- 脚本内含的三个技术要点必须落地（均为总控已验证的既有事实，不需重新发现）：① @/ 别名映射到 src/；② 无扩展名相对导入仅当父模块为 .ts/.tsx 时才补扩展名，否则会破坏 react/index.js 的 CJS 解析；③ 必须 stub @xyflow/react 这一层，因为 react-dom 的 CJS 内部 require 不会被 ESM hook 拦截。另需 stub globalThis.window（tauriStorage.ts:100 有顶层 window.addEventListener）。
- 必须实际运行并记录当前的失败输出作为红状态证据，写进交付说明。若某用例当前意外通过，必须如实说明而不是调整断言使其失败。
- 在 package.json 的 scripts 中新增一条 regression:queue 条目，不改动其他现有条目。
- node ./node_modules/typescript/bin/tsc --noEmit 保持 PASS。
- 不新增任何需要安装的依赖（不使用 vitest/jest/jsdom/happy-dom），脚本仅使用 Node 内置模块。
- 不修改任何业务源码（src/stores/queueStore.ts、src/hooks/useImageGeneratorExecution.ts 等保持原样）；本任务只新增测试基础设施。

## 测试适用性

- 既有行为：保持
- 原始基线：PASS；项目原本没有任何自动化行为测试（0 测试文件、0 lint；唯一 CI 只在 v* tag 触发且无 typecheck 步骤），故不存在可继承的旧套件。基线由总控自建的三个零依赖探针确立，均已实际运行并记录原始输出：(1) probe-queue-store.mjs 复现 REQ-001（重启遗留 queued 任务 250ms 无变化，显式 pump() 后转 error）；(2) probe-partialize-deadbranch.mjs 穷举证明 partialize 恒不输出 running，故 queueStore.ts:217-226 恢复分支不可达；(3) probe-dup-enqueue.mjs 用 react-dom/server 的 renderToStaticMarkup 驱动真实 React hook，证明 REQ-002 红状态：同一节点连续三次 handleGenerate 后活动 job 数为 1→2→3，退出码 1（预期红）。已知限制：vite build 在沙箱因 esbuild spawn EPERM 不可运行；cargo 因 TLS 凭证失败未运行；本基础设施只覆盖 store 与 hook 级逻辑，不覆盖真实 Tauri 运行时、渲染与 HTTP 调用。
- 基线证据：.workflow-kit/tasks/evidence/probe-dup-enqueue.mjs
- 需求决定：DEC-zero-dep-verification
- 补充：自动化行为测试基础设施（原为完全缺失）；基线证明项目无任何行为测试，且 tsc 已实证抓不到整模块死代码（imageService.ts 393 行零引用仍 PASS）与逻辑死分支。按 DEC-zero-dep-verification 补充零依赖门禁基础设施，使后续 REQ-001/REQ-002 修复具备红→绿可执行证据。；验证：harness-runs
- 保留：tsc --noEmit 类型门禁；strict + noUnusedLocals + noUnusedParameters 全开且当前零诊断，是项目唯一既有自动化保护，必须继续运行并保持 PASS。；验证：typecheck

## 执行与恢复

- 首次开始：2026-09-28T03:03:20.641805Z
- 原截止时间：2026-09-28T06:03:20.641805Z
- 当前截止时间：2026-09-28T06:03:20.641805Z
- 时钟：按活动时间计：已用 1 分钟 / 额度 180 分钟（等待、断网和只读门禁不计）
- 已用修复轮：0
- 阻塞：无
- 下一步：如需同一目标，准备新的任务并引用本任务作为历史

## 最近检查点

- 2026-09-28T03:03:20.704575Z：开始执行，保留原任务身份和截止时间；下一步：完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify
- 2026-09-28T03:04:28.297327Z：Interrupted run recovered: 总控核对：门禁规格存在工具不支持字段（expect_failure），在 verify 阶段会把红状态门禁判为 FAIL 而使任务阻塞。总控于编码子代理开始落盘前中断其工作（已确认 scripts/ 与 package.json 均无改动，deliverable 不存在），故本次运行无候选、无副作用，可安全关闭。将重新准备带 --expect-red 自检模式的正确任务定义。；下一步：先核对已有文件及原始日志，再处理 interrupted；不要新建任务或重置预算
- 2026-09-28T03:04:32.928245Z：任务已取消：门禁规格含工具不支持的 expect_failure 字段，会致红状态门禁在 verify 时被误判为 FAIL。改为脚本自身提供 --expect-red 自检模式（红状态符合预期时退出码 0，意外变绿则非 0）。编码子代理的工作在修正后的新任务卡下继续，已产出的设计不受影响。；下一步：如需同一目标，准备新的任务并引用本任务作为历史

## 原始证据

[唯一状态记录](../items/TASK-004.json)

- [RUN-3bd9914368c54997a28e3c0707a05b29](../runs/RUN-3bd9914368c54997a28e3c0707a05b29.json)

卡片是自动生成的视图。Agent 修改任务记录、执行命令或保存检查点后重新生成；不手工把状态改成通过。
