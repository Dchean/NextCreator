# TASK-006 实机验收结果（总控亲自执行，2026-09-29 下午场）

> 依据：用户本轮指令「你实测验收，实机的也由你负责」
> 执行者：总控（release 应用 + 真实 CDP 鼠标/键盘事件）
> 结果：**6/6 场景全部 PASS**（驱动 `live-verify.mjs`，报告 `live-report.json`）

## 与上午场（11:57–14:06）的关系

上午场用 CDP 驱动真实 WebView2 完成了 7 场景（记录见
`TASK-006-MANUAL-VERIFICATION-RESULT.md`，19 张截图）。本场是**在本次会话内独立重跑**，
不采信上午的数字，并补充了上午未覆盖的量化断言。

## 环境（本场实测）

- 被测应用：`D:\NextCreator\src-tauri\target\release\nextcreator.exe`
  （2026-09-29 11:56 构建；用 vite devUrl = 等价 `tauri dev` 形态）
- 前端：`node_modules/.bin/vite --port 1420 --strictPort`（HTTP 200）
- CDP：9222，实测 `Browser=Edg/154.0.4258.37`
- WebView2 用户数据目录放在 `src-tauri/target/nc-live-profile`（跑完已删除）
- 真实用户数据：跑前备份、跑后逐字节还原（sha256 均为 `824a7e33…`，mtime 未变）

## 逐场景结果

| # | 场景 | 结果 | 实测证据 |
|---|------|------|----------|
| S0 | 实机就绪 | ✅ | 真实应用渲染、选中生成节点、真实键盘写入提示词、队列面板可见（并发=2） |
| S1 | 同一节点连点 3 次（REQ-002） | ✅ | 真实鼠标连点 3 次 → 该节点 job 数 **0→1**（状态 error：本地网关未启动，属预期） |
| S2 | 批量 n=4 与「不被历史任务锁死」 | ✅ | 单次点击产生**恰好 4 个** job（batchTotal=4）；该批结束后再点一次**再新增 4 个**（证明历史任务不锁死重生成） |
| S3 | 暂停态连点 3 次 | ✅ | 队列暂停中连点 3 次 → 该节点活动任务**恰好 1 个 queued**；截图显示按钮变为禁用「排队中...」 |
| S5 | 排队中强杀重启（REQ-001） | ✅ | 真实 `taskkill` 强杀 → 重启后遗留 queued **降为 0**（终态 error=「节点不存在/失败」），节点 `queued=false`，DOM 无「排队中」 |
| S7 | 被拒点击的反馈 | ✅ | 暂停 + 该节点已有 3 个 queued 时按钮**可点**；真实点击 → toast「该节点仍有任务在排队中，本次点击未生效（可等待完成或用队列面板取消）」出现，且总 job **3→3 零增长** |

截图：`shots/B0-booted.png` … `shots/B6-s5-after-restart.png`（S3、S7 已由总控亲自看图核对）。

## 本会话的环境限制（如实记录，影响取证方式）

本会话的 DSH 沙箱使**应用子进程无法写 `%APPDATA%\com.sy.nextcreator\app-data.json`**
（浏览器控制台实测 `Storage save error: 拒绝访问。 (os error 5)`）。因此：

- 断言**不读落盘文件**，改为经 Vite dev 模块 `/src/stores/*.ts` 读取应用**自身**的
  zustand store —— 与 UI 使用的是同一批实例（已核对 `useQueueStore.getState()` 等）。
- S5 的「重启前持久化文件」由驱动**按应用自身格式**写入（含 `generation-queue` 的
  `{state:{jobs,concurrency,paused},version:0}`，与上午真实会话产出的
  `app-data.json.after-test` 结构一致），随后真实强杀 + 重启。
- S7 的「被拒窗口」用应用自身 `enqueue` 构造（暂停 + 3 个 queued + 节点 UI 空闲），
  点击与 toast 判定均为真实鼠标/真实 DOM。

## 未覆盖项（如实记录）

- 未跑真实 API 端到端：本机本地网关（127.0.0.1:8317）未启动，所有任务以失败告终；
  队列语义断言不依赖结果成功与否。
- S5(d) 变体「节点已不存在时的处置」未构造。
- 未验证 macOS、未做真实浏览器外的渲染层验证。
