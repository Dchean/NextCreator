# ADR-0004：发布 tag 必须与应用版本号严格一致

状态：accepted。用户/管理角色决定依据：用户指令「对齐，并且后续的都要对齐」。适用模块：`.github/workflows/release.yml`、`.github/scripts/verify-version-alignment.mjs`、`.github/scripts/prune-release-assets.mjs`、`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。

## Problem

安装包文件名与 Release 名称来自**两个不同的数据源**：

| 呈现 | 数据源 |
|---|---|
| 安装包文件名（`NextCreator_<版本>_x64-setup.exe`） | `tauri.conf.json` 的 `version` |
| Release 标题（`NextCreator v<tag>`） | git tag |

本项目在 v0.2.6 之后一直是"先打 tag 推进里程碑、应用版本号留着不动"的节奏，于是两者持续错位：tag 已到 v0.2.10 / v0.3.0，而应用版本仍为 0.2.6 / 0.2.10。实际后果是发布页上出现**标题与安装包并非同一版本**的组合（例如标题 v0.3.0、下载到的却是 `NextCreator_0.2.10_x64-setup.exe`），用户无法从文件名判断自己拿到的是哪个版本。

这不是一次性的笔误，而是**流程缺少约束**：没有任何环节校验 tag 与版本号一致，全靠人工记得同步。

## Proposal

1. **版本号是唯一事实来源**：发布 tag 必须严格等于 `v` + 应用版本号；四处版本字段必须相同（`package.json`、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock` 的 workspace 成员）。
2. **在流水线入口强制校验**：`verify-version-alignment.mjs` 在每个平台 job 的 checkout 之后立即运行，任一不一致即让 job 失败，发布不会产出。
3. **发布前清理错版本残留**：`prune-release-assets.mjs` 在同一 tag 重发时删除名字里带**其它版本号**的资产，避免发布页同时挂多个版本的安装包。
   - 判定按"名字中出现的版本号 token"进行：含当前版本 → 保留；含其它版本 → 删除；**不含任何版本号 → 保留**（例如 `NextCreator_aarch64.app.tar.gz` 这种升级包，无法判定归属，误删会造成产物缺失）。
4. **发布动作 = 升版本 + 打 tag 两步合一**：升版本提交与 tag 指向同一提交，避免"tag 领先、版本落后"。

## Alternatives considered

- **只靠人工约定**：rejected。错位已经连续发生多次，说明约定无效；必须有机器校验。
- **让 tag 跟随版本号自动生成**：rejected。tag 同时承担"里程碑标记"的语义，自动生成会削弱它作为人工决策点的作用；而且本项目的过程 tag（如 `v0.2.7-checkpoint`）本身就带非版本语义。
- **把版本号从文件名里去掉**：rejected。安装包文件名带版本号对用户排查问题和多版本共存有实际价值。
- **清理旧版本资产时删除所有不匹配项**：rejected（实测教训）。`NextCreator_*.app.tar.gz` 不含版本号，按"不匹配即删"会误删 macOS 升级包。

## Consequences

- 每次发布前必须先把四处版本字段升到目标版本，再打同名 tag；升版本提交与 tag 指向同一提交。
- 若违反，CI 会在构建开始前失败，不会产生版本号错误的安装包（代价是多一次推送，收益是杜绝错版发布）。
- 历史 tag（v0.2.7 ~ v0.2.10）的 Release 仍保留其当时的产物（0.2.6 构建），属历史记录；如需与新规则统一，需另行决定重建或下架，不在本 ADR 范围内。
- 本 ADR 只约束发布流程，不改变应用运行时行为；不影响已发布的 v0.3.0 产物内容。
