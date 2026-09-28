# TASK-006 规格摘要（总控提取，供编码者直接使用）

本文件是 `scripts/queue-regression.mjs`（1075 行）的精简规格。**你不需要读那个 68037 字节的门禁文件**，
只需读本文件 + 你要改的源码。改完后由门禁判定，你只管实现。

---

## 你要改的文件（仅这 4 个，越界会被拒收）

- `src/stores/queueStore.ts`（230 行）← REQ-001 与 REQ-002 的主战场
- `src/hooks/useImageGeneratorExecution.ts`（90 行）
- `src/App.tsx`（仅在确有必要时）
- `src/main.tsx`（仅在确有必要时）

**禁止改**：`scripts/**`（门禁，不得动它让自己通过）、`src/services/imageGenerationExecution.ts`、
`src/utils/tauriStorage.ts`、`src/services/imageGeneration/**`、`src-tauri/**`、`.workflow-kit/**`。

---

## REQ-001 的症状与证据（已确认，不需重新证明）

重启后遗留的 `queued` 任务永不执行，节点被永久锁死。

1. `queueStore.ts:209-212` 的 `partialize` 只持久化 `status !== "running"` 的任务；
   而 `:213-228` 的 `onRehydrateStorage` **恰好只查找 `status === "running"`** → **该分支恒不可达**。
2. `pump()` 只由 `enqueue`(`:68`)、`setConcurrency`(`:114`)、`togglePaused`(`:119`) 调用；
   `App.tsx` / `main.tsx` 中无引用 → **启动时无人调用**。
3. 后果：任务永久停在 `queued` → `ImageGeneratorNode.tsx:174` 的 `isQueued` 恒真
   → `:215` 的 `canRun = hasResolvedPrompt && status!=="loading" && !isQueued && !sizeValidationError` 恒假 → 节点锁死。

**已确认行为**：重启后未完成的任务**自动恢复并继续生成**（会产生真实 API 费用，用户已接受）。

## REQ-001 要求

1. 使 `partialize` 与恢复逻辑**意图自洽**。**硬性要求：不允许留下不可达的恢复分支。**
2. 水合完成后**实际触发 `pump()`**，让恢复的任务真正开始执行。
3. 恢复路径须能处理"节点不存在 / 画布已切换"（此时 `executeImageGeneration` 返回"节点不存在"），
   **不得再卡在 `queued` 或 `running`**。
4. **恢复必须落在 store 层**（如 `onRehydrateStorage` 内），**不能**放 `App.tsx` 的 `useEffect`
   —— 门禁只驱动 store 水合链路、不 mount App。
5. **必须同时清除对应节点的 `data.queued` 标记**（否则用户仍看到按钮禁用 + "排队中"）。
6. 处理**恢复早于画布就绪的竞态**。
7. **防止崩溃循环**：恢复后若立即崩溃，不得无限重试。

---

## REQ-002 的症状与证据

同一节点重复入队无保护。`useImageGeneratorExecution.ts` 的 `handleGenerate` 在入队前无早退检查；
连点会创建多个 job 并发写同一 `node.data`。原 `taskManager.isTaskRunning` 的保护在重构中丢失。

## REQ-002 要求（7 条，均为五轮独立审查确定的规格）

1. **守卫放在 `queueStore.enqueue` 内做同步判定** —— 不能只放 `handleGenerate` 入口。
   （重叠点击与 `retry` 两条路径都能绕过入口级守卫。）
2. **按"用户点击"整批原子判定** —— 不能逐个 job 判重。
   （`useImageGeneratorExecution.ts:61-74` 在 `batchCount > 1` 时**一次点击合法产生多个同节点 job**；
   逐个判重会把批量截断成 1。）
3. **只判定该节点的活动任务（`queued || running`）** —— 不得对**历史**任务判重（否则锁死重试与重生成）。
4. **不得写成"仅判定 `running`"**（历史上 `taskManager.isTaskRunning` 即该形态）。
5. **不得写成全局单飞**（不按 nodeId 区分、任何节点有活动 job 就拒绝），会禁掉不同节点并发。
6. **【门禁不覆盖，你必须自行保证】暂停态**：守卫**不得**在 `queueStore.paused` 为真时跳过判定。
   原因：暂停时 `ImageGeneratorNode` 的生成按钮**仍可点**（`canRun` 不看 `paused`），
   而 `data.queued` 在首个 `await` 之后才写（`useImageGeneratorExecution.ts:86-90`），
   故暂停时连点会累积并发任务。**请自行测试暂停态**（手动设 `paused: true`）。
7. 保持 `concurrency` 钳制 1..4（`queueStore.ts:112`）与既有取消语义不变。

---

## 门禁的六条判据（这就是验收标准，逐条对应上面要求）

| 用例 | 判据（原文提取自门禁，行号供参考） |
| --- | --- |
| A | `:358` ① 该 job 不再停留在 `queued`；② 对应节点 `data.queued` 被清除（falsy） |
| B | `:496` 3 次连点后**同节点 job 数恒为 1**，且全程活动数（queued+running）峰值 ≤ 1 |
| C | `:707-709` 批量 `n=4`：① 首点后同节点 job 数 **== 4**（整批完整拆分）；② 第 2/3 次点击**不再增长**；③ 该批结束后再点一次仍产生**完整一批**（不得因历史 job 锁死重生成） |
| D | `:769` ① 首点后节点 B 的 **queued 数 == 1**（不得被其他节点占用连带拒绝）；② 第 2/3 次点击后不再增长 |
| E | `:899` **3 次重叠点击**（不 await 上一次）后同节点 job 数 **== 1** |
| F | `:990` 连续 `retry` 只应产生 **1 个新任务**，不得让同节点并发任务累积增长 |

## 验收命令（必须实际运行并保存原始输出）

```
node --experimental-strip-types scripts/queue-regression.mjs
```
- 当前：**6 个 FAIL，退出码 1**（红状态）
- 目标：**6 个 PASS，退出码 0**（绿状态）
- **红→绿是硬性要求**：改动前先跑一次存档，改动后再跑存档。只报最终 PASS 视为未证明。

```
node ./node_modules/typescript/bin/tsc --noEmit          # 目标退出码 0
node --experimental-strip-types scripts/queue-regression.mjs --expect-red   # 修复后应为退出码 1（红状态不再成立）
```

## 禁止事项

- **不得修改 `scripts/**` 让自己通过**。若某条断言与需求冲突，**停止并报告**，不要删断言。
- 不新增/升级依赖；不改 UI 外观与交互；不改节点数据字段语义；不改画布或 `app-data.json` 既有字段含义。
- **不要执行任何 git 命令**；不要修改 `.workflow-kit/**`。
- 环境：`node` 24.19.0；`vite build` 与 vitest 在本沙箱不可用（esbuild `spawn EPERM`）；`cargo` 不可用。
