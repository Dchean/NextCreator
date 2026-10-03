<div align="center">
  <img src="docs/images/logo.png" alt="NextCreator Logo" width="120" />
  <h1>NextCreator <sub>二改版</sub></h1>
  <p>基于可视化节点的 AI 内容生成工作流工具</p>

  ![Version](https://img.shields.io/badge/version-0.4.1-blue.svg)
  ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)
  ![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB.svg?logo=tauri&logoColor=white)
  ![License](https://img.shields.io/badge/license-AGPL%20v3-blue.svg)
</div>

---

## 二改声明

**本仓库是 [MoonWeSif/NextCreator](https://github.com/MoonWeSif/NextCreator) 的二次修改版（二改），不是原作者发布的版本。**

| | |
|---|---|
| 上游原作者仓库 | https://github.com/MoonWeSif/NextCreator |
| 本二改仓库 | https://github.com/Dchean/NextCreator |
| 关系 | 本版由本仓库维护者独立修改维护，**与上游无隶属关系，上游不对本版内容负责** |
| 下载 | 请从**本仓库**的 [Releases](https://github.com/Dchean/NextCreator/releases) 下载；版本号见上方徽章 |
| 版权 | 原始代码版权归原作者所有；本版修改部分依 **AGPL-3.0 第 5 条**标注改动与日期 |
| 最后修改 | 2026-09-30（对应 v0.4.1） |

> 若你是从上游仓库来到此处，请注意本版的安装包、版本号与行为均可能与上游不同，
> 遇到问题请到**本仓库**反馈，不要打扰上游作者。

## 本二改版相对上游的改动

| 领域 | 改动 |
|---|---|
| 生成队列可靠性 | 重启后遗留的排队任务会被正确处置（不再永久停在"排队中"）；同一节点重复点击不会重复入队（含批量拆分、并发点击、失败重试路径） |
| 并发控制 | 引入**全局单一并发上限**：生成队列与工作流路径共用同一个额度来源，避免两条路径各自开闸导致总并发失控 |
| 执行链统一 | 工作流中的图片节点与生成队列**共用同一套执行实现**，消除此前两份平行实现导致的行为不一致 |
| 取消语义 | 取消后不再把已返回的结果写回节点状态与运行记录；同时明确取消**不能**中止已发出的在途请求 |
| API Key 存储 | 密钥改存**操作系统凭据库**（Windows 凭据管理器 / macOS Keychain），本地配置文件不再保存明文；旧配置在升级后自动迁移；并加固了错误信息中可能带出凭据的路径 |
| 死代码清理 | 删除零外部引用的历史模块，减小体积与维护面 |
| 行为回归门禁 | 新增零依赖行为回归脚本（`scripts/queue-regression.mjs`），覆盖队列与并发相关的关键行为，防止回归 |
| 发布流程 | 发布 tag 与应用版本号**强制对齐**（CI 校验），保证 Release 标题与安装包文件名一致 |

## 功能特性

- **节点编辑器** - 拖拽式工作流设计，支持撤销/重做、复制粘贴、自动布局、视口裁剪渲染（大量节点不卡顿）
- **多画布管理** - 创建多个独立画布，数据自动持久化
- **AI 图片生成** - 支持 Gemini (NanoBanana) / OpenAI Images (GPT-Image) 等协议的文生图、图生图
- **模型列表实时获取** - 从供应商接口拉取可用模型列表（支持 OpenAI 兼容 / Google / Claude 协议），无需手动输入模型名
- **生成队列** - 多任务排队与并发控制（1-4），支持取消、失败重试、批量拆分；跨画布任务不丢失
- **全局画廊** - 汇总所有画布生成的图片，按画布/模型筛选，查看提示词，拖回画布复用，在文件夹中显示
- **图片存储位置可配置** - 在设置中自定义图片保存目录，切换时可选迁移已有图片
- **缩略图加速** - 生成结果自动生成缩略图，画布、检查器、画廊均以缩略图预览，大图查看时才加载原图
- **输出复用** - 生图节点的输出图可直接拖拽到画布转为输入节点，右键菜单支持"以此图继续生成（变体）"
- **图片蒙版重绘** - 在图片输入节点上直接涂抹蒙版，精准选定区域后交由 AI 局部重绘
- **LLM 文本生成** - 支持多模态输入（文本/图片/PDF），可辅助润色提示词
- **Prompt 提示词库** - 内置大量绘图提示词，可拖拽至画布，快速使用，可添加自定义提示词，收藏你喜欢的提示词
- **工作流编排** - 支持工作流批量并行启动

## 截图预览

### 主界面
![主界面](docs/images/main-interface.png)

### Prompt 库

**Pormpt 提示词库** - 内置几十种提示词，可以拖拽至画布，快速开始使用
![Prompt 库](docs/images/prompt.png)

### 图片蒙版重绘

**蒙版绘制** - 在图片输入节点内直接用画笔涂抹需要修改的区域（红色高亮标记），再连接图片生成节点，AI 将只对选中区域进行局部重绘，其余部分保持不变。
![图片蒙版重绘](docs/images/mask.png)

## 快速开始

前往本仓库 [Releases](https://github.com/Dchean/NextCreator/releases) 下载最新版本
（当前 `0.3.1`，安装包文件名中的版本号即应用版本号）：

- **macOS (Apple Silicon)**: `NextCreator_0.4.1_aarch64.dmg`
- **macOS (Intel)**: `NextCreator_0.4.1_x64.dmg`
- **Windows**: `NextCreator_0.4.1_x64-setup.exe` 或 `NextCreator_0.4.1_x64_en-US.msi`

### macOS 安装提示

由于应用未经 Apple 签名，首次打开可能会提示"无法验证开发者"。请在终端执行以下命令解决：

```bash
xattr -rc "/Applications/NextCreator.app"
```

## 使用流程

1. **配置供应商** - 点击右上角「供应商管理」，添加 API 供应商（如 OpenAI、Google Gemini 等），可用「测试连接」验证并拉取模型列表
2. **分配供应商** - 在供应商管理中为不同节点类型（图片生成、LLM 等）指定默认供应商
3. **自定义存储位置**（可选）- 在「设置 → 图片存储位置」中选择图片保存目录
4. **创建工作流** - 从左侧节点面板拖拽节点到画布，连接节点构建工作流
5. **运行生成** - 填写输入内容，点击节点的生成按钮，任务进入生成队列并发出；通过右上角队列图标查看进度、取消或重试
6. **查看画廊** - 在左侧「画廊」中浏览所有生成过的图片，可拖回画布继续加工

> **关于 API Key**：密钥保存在操作系统的凭据库中，不写入应用配置文件。
> 从旧版本升级时会自动迁移；若凭据库不可用，应用会提示且保留原有配置，不会丢失密钥。

## 本地开发

```bash
# 安装依赖
bun install

# 开发模式
bun run tauri dev

# 构建应用
bun run tauri build
```

### 质量门禁

```bash
# 类型检查
node ./node_modules/typescript/bin/tsc --noEmit

# 行为回归（零依赖，直接加载 src 下的真实模块）
node --experimental-strip-types scripts/queue-regression.mjs

# Rust 单元测试
cd src-tauri && cargo test --release --lib
```

## 发布流程

本仓库的发布遵循一条硬规则：**发布 tag 必须等于应用版本号**（`v0.3.1` ↔ 版本 `0.3.1`）。

原因：安装包文件名取自 `tauri.conf.json` 的 `version`，而 Release 标题取自 git tag，
两者若不一致，用户会下载到与页面标题不符的版本。CI 已加入校验，不一致会直接让发布失败。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Tailwind CSS + daisyUI |
| 后端 | Tauri 2 (Rust) |
| 状态 | Zustand + IndexedDB |
| 节点 | @xyflow/react |

## 致谢

- **上游原作者**：[MoonWeSif/NextCreator](https://github.com/MoonWeSif/NextCreator) —— 本二改版基于该项目，感谢原作者的完整实现
- [awesome-nanobanana-pro](https://github.com/ZeroLu/awesome-nanobanana-pro) & [banana-prompt-quicker](https://github.com/glidea/banana-prompt-quicker) - 本项目的内置提示词参照两个仓库,感谢项目作者的整理与各个提示词的贡献者。

## 许可证

本项目基于 [GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html) 发行，详细条款请参阅仓库根目录的 `LICENSE` 文件。

作为二次修改版，本仓库依 AGPL-3.0 第 5 条在 [二改声明](#二改声明) 与
[本二改版相对上游的改动](#本二改版相对上游的改动) 中标注了修改内容与日期；
原始版权与许可声明予以保留。
