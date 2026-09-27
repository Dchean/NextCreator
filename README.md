<div align="center">
  <img src="docs/images/logo.png" alt="NextCreator Logo" width="120" />
  <h1>NextCreator</h1>
  <p>基于可视化节点的 AI 内容生成工作流工具</p>

  ![Version](https://img.shields.io/badge/version-0.2.6-blue.svg)
  ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)
  ![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB.svg?logo=tauri&logoColor=white)
  ![License](https://img.shields.io/badge/license-AGPL%20v3-blue.svg)
</div>

---

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

前往 [Releases](https://github.com/MoonWeSif/NextCreator/releases) 下载最新版本：

- **macOS (Apple Silicon)**: `NextCreator_*_aarch64.dmg`
- **macOS (Intel)**: `NextCreator_*_x64.dmg`
- **Windows**: `NextCreator_*_x64-setup.exe`

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

## 本地开发

```bash
# 安装依赖
bun install

# 开发模式
bun run tauri dev

# 构建应用
bun run tauri build
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Tailwind CSS + daisyUI |
| 后端 | Tauri 2 (Rust) |
| 状态 | Zustand + IndexedDB |
| 节点 | @xyflow/react |

## 致谢

- [awesome-nanobanana-pro](https://github.com/ZeroLu/awesome-nanobanana-pro) & [banana-prompt-quicker](https://github.com/glidea/banana-prompt-quicker) - 本项目的内置提示词参照两个仓库,感谢项目作者的整理与各个提示词的贡献者。

## 许可证

本项目基于 [GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html) 发行，详细条款请参阅仓库根目录的 `LICENSE` 文件。
