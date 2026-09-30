# ADR-0001：queueStore 重启恢复改为自动继续，并修复不可达的恢复分支

状态：accepted。用户/管理角色决定依据：`DEC-restart-queue-resume`。适用模块：`src/stores/queueStore.ts`、`src/hooks/useImageGeneratorExecution.ts`。

## Problem

应用重启后，未完成的图片生成任务永久停留在 `queued`，且相关节点持续显示"排队中"并禁用生成按钮。

已实测的证据（非静态推断）：

1. `queueStore.ts:209-212` 的 `partialize` 只持久化 `status !== "running"` 的任务。
2. `queueStore.ts:213-228` 的 `onRehydrateStorage` 恰好只查找 `status === "running"` 的任务，用于标记"应用重启导致中断，可重试"。
3. 穷举验证 `persist.getOptions().partialize()` 的输出状态集合为 `queued, success, error, cancelled` —— **恒不包含 `running`**，因此上述恢复分支是不可达的死代码，永不执行。
4. `pump()` 全项目仅由 `enqueue`(`:68`)、`setConcurrency`(`:114`)、`togglePaused`(`:119`) 触发；`App.tsx` 与 `main.tsx` 均无 `pump` 或 `useQueueStore` 引用，**启动时无人调用**。

后果链：设计意图（重启 → 标记为可重试的 error）被 `partialize` 的过滤悄悄取消；由于 `running` 被过滤掉，连"卡在 running"都不会出现，而是**永久卡在 queued**。`ImageGeneratorNode.tsx:174` 的 `isQueued` 因此恒为真，`:215` 的 `canRun` 恒为假。

已验证的复现（`probe-queue-store.mjs`，退出码 0）：

```
simulated restart -> stale job status: queued
after 250ms WITHOUT explicit pump -> stale job status: queued
after EXPLICIT pump -> stale job status: error
```

用户可见影响：节点卡死后**无法再生成**。可恢复路径是到队列面板对 queued 任务点取消（`QueuePanel.tsx:206-211` → `cancel()` → `updateNodeQueuedState(..., false)`），但用户需自行发现这一点。

## Proposal

采用**行为变更**，由 `DEC-restart-queue-resume` 确认：重启后未完成的任务**自动恢复并继续生成**（可能产生真实 API 费用），而不是标记为失败等待手动重试。

实施要求：

1. 使 `partialize` 与恢复逻辑的意图自洽。**不允许留下仍然不可达的分支**——这是本 ADR 的硬性验收点。
2. 在水合完成后实际触发调度（`pump()`），使恢复的任务真正开始执行。
3. 恢复路径必须能处理"任务引用的节点已不存在 / 已换画布"的情况（`imageGenerationExecution` 会返回"节点不存在"），不得因此再次卡在 queued 或 running。
4. 保持 `concurrency` 钳制在 1..4（`queueStore.ts:112`）与现有取消语义不变。

验证方式：新增零依赖回归门禁（见 ADR-0002），其中"重启恢复"用例必须能在修复前失败、修复后通过。

## Alternatives considered

- **保持现状（不改）**：即时成本最低。但用户已确认这是真实故障且节点会被永久锁死，且 `pump()` 缺失是客观缺陷。否决。
- **仅补一次启动 `pump()` 调用**：能消除"永久卡 queued"，但**不解决死分支**——`onRehydrateStorage` 里那段恢复逻辑仍然永远不执行，只是它的缺席不再造成卡死。属于把两层问题修掉一层，留一层继续误导后续维护者。否决为最终方案，但可作为实施的第一步。
- **修正 `partialize` 保留 `running`，让原分支生效（标记为可重试的 error）**：改动最小、与原作者意图一致（关键：`running` 被过滤掉说明"重启时应中断"的意图是存在的，只是实现自相矛盾）。代价是**与用户新确认的行为相反**——用户要的是自动继续，不是标记失败。因此记录为被替代方案。
- **重启后直接丢弃未完成队列**：最无意外、不产生费用。但用户明确选择了自动恢复而非丢弃，故否决。

## Consequences

收益：消除一个用户可见的卡死故障；恢复分支不再是不执行却看起来有效的代码；队列具备真实的跨重启语义。

代价与风险：
- 自动恢复会**在用户未主动操作时发起真实付费请求**（用户已明确接受）。
- 恢复时机与画布加载存在顺序耦合：若恢复早于画布数据就绪，任务会因"节点不存在"失败。实施时必须处理该竞态，否则缺陷换形式复现。
- 崩溃循环风险：若应用在恢复后立即崩溃，可能反复重试。需确保恢复有次数或状态约束，不无限重试。
- 回滚：`queueStore.ts` 与 hooks 的改动可通过 `git revert` 单独还原；不涉及数据格式迁移，故无数据回滚问题。

后续维护：`partialize` 的过滤列表与 `onRehydrateStorage` 的查询条件今后必须成对审查——本次缺陷正是二者不一致所致。
