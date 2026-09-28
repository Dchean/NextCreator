# NextCreator 重构评估（只读分析）

- 目标项目：`D:\NextCreator`
- 基线：`main` @ `750e4fd`（2026-09-28），工作区相对 HEAD 干净
- 结论性质：**评估建议，不是决定**。路线由用户选择。
- 本文所有坐标均由实际读取/命令验证，未修改任何源码。

## 一、先说一个被纠正的前提

会话开始时 `git log -1 --pretty=%s` 的输出是一长串文件名，**看起来像 git status 的未提交改动清单，实际是提交 750e4fd 的 subject 文本**。

核实结果：
- `git status --porcelain --untracked-files=all` 真实输出只有 5 行：1 个已跟踪的规划文件被删（未暂存），加上本次接入新增的 3 个入口文件与 `.workflow-kit/`。
- `git diff HEAD --name-only` 仅 1 个文件。

**即：那次 128 文件 / 7745+ / 24177- 的大规模重构（删除 video、PPT、text removal、taskManager）已经提交，不是待处理的未提交改动。** 这改变了风险评估：重构已落地，现在要评估的是"落地后的现状"。

## 二、已实测的真实基线

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | **PASS**（退出码 0） |
| 前端构建 | `vite build` | **BLOCKED** — esbuild `spawn EPERM`，是本机会话沙箱对子进程管道 stdio 的限制，不是项目缺陷 |
| Rust 检查 | `cargo check` | **BLOCKED** — crates.io TLS 失败（`SEC_E_NO_CREDENTIALS`）；`--offline` 也失败（本地缓存缺 `image` crate） |

`tsconfig.json` 已开启 `strict` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch`，在此强度下零诊断。

## 三、最重要的问题（按影响排序）

### 1. 重启后遗留的排队任务永不执行，节点卡在"排队中" — 已复核的真实缺陷

- `queueStore.ts:209-212` 的 `partialize` 只排除 `running`，**`queued` 会被持久化**。
- `queueStore.ts:213-228` 的 `onRehydrateStorage` 只修正 `running`，不处理 `queued`。
- `pump()` 仅由 `enqueue`(`:68`)、`setConcurrency`(`:114`)、`togglePaused`(`:119`) 触发，**启动时无人调用**。
- 后果：`ImageGeneratorNode.tsx:174` 的 `isQueued` 为真 → `:215` 的 `canRun` 为假，`:382` 持续显示"排队中"。

**我额外核实了严重程度，避免夸大**：`QueuePanel.tsx:206-211` 对 `queued` 任务提供取消按钮，`cancel()`（`queueStore.ts:76-83`）会把状态置为 `cancelled` 并调用 `updateNodeQueuedState(..., false)` 解锁节点。所以这是**可恢复的中度缺陷，不是永久砖化**——但用户必须知道去队列面板点取消。

### 2. 同一业务流程存在两条不共享实现的执行链

```
手动点击 → useImageGeneratorExecution → queueStore → imageGenerationExecution.ts (470 行)
                                                      有 runRecords / 取消 / 批量 / 缩略图
工作流   → WorkflowControls → flowStore → workflowEngine:435 → nodeExecutor.ts:390 (159 行)
                                                      以上能力全部没有
LLM      → useLLMContentExecution.ts (301 行) 自己写一遍 canvas-aware 读写，且绕过队列
```

- `grep runRecords src/services/nodeExecutor.ts` 为空。
- 并发上限互不知情：`queueStore.ts:58` `concurrency = 2`，`workflowEngine.ts:46` `maxParallelNodes = 3` → 最多 5 路并发打同一个 API Key，无全局背压。
- `updateNodeDataWithCanvas` 被写了三遍（`imageGenerationExecution.ts:102`、`nodeExecutor.ts:353`、`queueStore.ts:234`）。

### 3. 双画布"两份真相"

`canvasStore.canvases[].nodes` 与 `flowStore.nodes` 是同一数据的两份拷贝，靠手写同步维持，共 5 个写入者（`App.tsx:130/145/170`、`queueStore.ts:234`、`imageGenerationExecution.ts:102`）。`App.tsx:172` 的 `isLoadingCanvasRef` 挡回写与 `:159` 的 `requestAnimationFrame` 复位标志都是竞态补丁。

### 4. flowStore 是 1674 行的巨型 store

单文件承担 6 类职责：React Flow 渲染回调、图编辑、撤销重做、连线数据解析、**工作流引擎编排与 toast**、提示词模板实例化。`FlowCanvas.tsx:80-116` 单文件订阅 37 个 store 字段。

### 5. 门禁盲区的实证

- 全项目 **0 个测试文件**、0 lint 配置、Rust 侧 3035 行 0 个 `#[test]`。
- 唯一 CI（`.github/workflows/release.yml`）只在 `v*` tag 触发，**没有独立的 typecheck/lint/test 步骤**。
- 最有说服力的一点：`imageService.ts`（312 行）**全项目零外部 importer**，`imageCompression.ts`（81 行）同样零引用，合计 393 行死代码。而 `tsc` 在开启 `noUnusedLocals` 的情况下**依然通过**——因为死代码没有未使用的局部变量，只是无人 import。**这证明现有门禁存在结构性盲区**，不是泛泛的"没有测试"。

### 6. 其他已核实项

- **`dalle_generate_image` 没有断链**：`src-tauri/src/dalle.rs` 是活的，唯一调用者是 `src/services/imageGeneration/providers/gptImage.ts:198`（新 gptImageProvider 复用了这个 Rust 命令名）。被删的只是旧 `providers/dalle.ts`，属命名遗留。
- **被删模块无悬空引用**：对 PPTAssembler/PPTContent/VideoGenerator/KlingGenerator/VeoGenerator/videoGeneration/textRemoval/taskManager/NodePanel 逐一 grep，`src` + `src-tauri` 全部零命中。清理是干净的。
- **`lib.rs` 注册命令与前端 invoke 精确 24:24 对应**，两个方向差集为空：无僵尸注册，无缺失注册。
- **API Key 明文落盘**：`settingsStore.ts:164` 将含 `apiKey` 的 `settings.providers` 全量持久化到 `app-data.json`，全项目零加密。
- **失败即丢弃**：`gemini.ts:136` / `gptImage.ts:175` 只在发起前检查 `aborted`，`invoke` 无 signal 透传 → 取消无法中止在途请求（同样无法阻止计费）。
- **`@types/uuid` 已废弃**；`bun.lock` 与 `package-lock.json` 双锁文件并存，而 CI 与 tauri.conf 实际用 bun。

## 四、四条路线的证据与代价

### A. 保持现状
- 支持：清理干净、无悬空、tsc 通过、Rust 侧职责窄、跨 store 依赖只有 3 条。
- 反对：393 行死代码在门禁眼皮下存活；重启丢队列是**已存在的用户可见故障**；零回归网。
- 代价：即时成本最低，缺陷复利。若近期不再改动则成立。

### B. 局部修补
最痛且坐标明确的 5 个点（按收益/成本排序）：
1. `queueStore.ts:213-228` 补一次启动 `pump()` → 修 1 处，消除节点卡死。
2. `useImageGeneratorExecution.ts:62` 前加"同节点已在队/在跑则早退" → 恢复丢失的 `isTaskRunning` 语义，避免并发写同一 `node.data`。
3. provider 层在 `invoke` 返回后再查一次 `aborted`（`imageGenerationExecution.ts:312` 已用此模式，可对齐）。
4. 删除 `imageService.ts` + `imageCompression.ts`（393 行，零引用，零风险）。
5. 让 `workflowEngine.ts:46` 的并发上限从 `queueStore.concurrency` 读取，统一背压。

- 代价：**不触动结构**。双画布同步、双执行链、巨型 store 全部保留，随功能增长继续恶化。属止血。
- 限制：无测试网，只能人工回归（手动生成 / 工作流 / LLM / 批量 / 重启）。

### C. 渐进重构
结构性证据表明**不支持大爆炸**：
1. `components/nodes/imageGeneratorConfig.ts`（534 行）同时是类型源 + 默认值源 + 请求构造源，被 service 层 7 处反向 import（`nodeExecutor.ts:25`、`imageGenerationExecution.ts:20` 等）。"把执行逻辑移出 component"必须先拆它，而它同时被 UI 与执行链依赖 → **无法原子完成**。
2. 双画布真相有 5 个写入者，合并需同时改这 5 处 + `canvasStore.partialize` → **不可分割的跨文件改动，期间无法灰度**。
3. 但存在一个**现成的可行性支点**：`imageGenerationExecution.ts:34` 已有 `withRunRecords` 开关。让 `nodeExecutor.executeImageGeneratorNode` 改为调用 `executeImageGeneration`（关掉 runRecords）即可在**不改调用方**的前提下消除最大一处重复。

- 代价：第 2 项需要先有测试网才能安全推进；第 1、3 项可先用 `tsc` + 人工回归完成。

### D. 替换 / 迁移
- 反对：无任何外部集成契约需要保留（无公开 API、无插件系统、无第三方消费者），迁移不带来互操作性收益。核心资产 `flowStore`(1674 行) + 双画布同步 + 已调通的 24 个 Tauri 命令 + Rust 存储层(901 行)**没有一个被证明是错的**。
- 代价：最高，且现存技术债都是可增量消除的形态，不构成推倒重来的理由。

## 五、判断范围与不确定性

- 覆盖：`src/` 全部 107 个文件、`src-tauri/src` 全部 7 个文件、构建与 CI 配置、git 历史。
- **未验证**：前端构建与 Rust 检查因本机环境阻塞而未跑通（见第二节）。当前"可构建"结论**尚未由真实构建命令证明**。
- 未验证：应用实际运行行为（渲染性能、画布切换卡顿）均为静态阅读推断，**未在真实运行中测量**。
- 本文不包含任何已实施的改动。
