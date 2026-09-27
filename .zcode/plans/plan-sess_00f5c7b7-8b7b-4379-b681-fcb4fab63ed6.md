# NextCreator 生图专注版优化计划

## 现状结论

项目是 Tauri 2 + React 19 + React Flow 12 的节点式 AI 工作流工具，生图（约6k行）、视频（约8.7k行）、PPT（约7.8k行）并存。已验证的痛点根源：

1. **存储写死**：`src-tauri/src/storage.rs:84` 的 `get_images_dir()` 固定用 `<app-data>/images/`，设置面板只读展示，无法更改。
2. **预览卡顿**：`OverlayNodeLayer.tsx` 无条件渲染全部节点、无视口裁剪；节点/检查器直接用全分辨率原图或 base64 渲染（`imageCompression.ts` 的 `generateThumbnail()` 只有 PPT 在用）；无懒加载。
3. **模型写死**：`imageGeneratorConfig.ts:135,206` 硬编码预设列表，全项目无 `/v1/models` 拉取逻辑。

已验证可安全删除的耦合：`textRemovalService.ts` 仅被 PPTAssemblerNode 使用；`@google/genai` 在 src/ 中零引用。

## 阶段一：精简 + 三大核心痛点（本次必做）

### 1. 彻底删除视频与 PPT 【假设：彻底删除而非隐藏，git 历史可找回】
- 前端：`VideoGeneratorNode/VeoGeneratorNode/KlingGeneratorNode/videoGeneratorConfig`、`PPTContentNode/`(13文件)、`PPTAssemblerNode/`(5文件)、对应 Inspector 与 `useVideoGeneratorExecution`、`services/videoGeneration/`、`services/taskManager.ts`（仅服务视频轮询）、`textRemovalService.ts`。
- 注册与类型：`nodeConfig.ts` 视频/PPT 分类、`nodes/index.ts`、`overlayNodeRegistry.tsx`、`types/index.ts` 中 `VideoGeneratorNodeData`/`NodeProviderMapping` 的 video/veo/kling 键、`connectionValidator.ts` 中 video 类型句柄。
- Rust：删除 `src-tauri/src/video.rs`（1974行）与 `text_removal/` 模块（约1974行，仅 PPT 用），`lib.rs` 移除命令注册。
- 依赖：移除 `pptxgenjs`、`@google/genai`（未使用）。
- **兼容处理**：画布加载时过滤已不存在的节点类型及其连边（避免旧画布报错），保留提示词/图片输入/生图/LLM/文件上传节点。

### 2. 存储位置可配置（含可选迁移）
- Rust：新增 `storage-config.json`（app-data 下）记录自定义根目录；`get_images_dir()` 优先读配置，否则回退默认；新命令 `get_storage_config` / `set_storage_config` / `migrate_images(新根目录)`（同盘 rename、跨盘复制）。
- 启动及切换目录时对 asset protocol scope 运行时扩展授权（否则自定义目录的图片无法通过 `convertFileSrc` 显示）。
- 前端：`settingsStore` 增加 `imageStorageRoot`；`SettingsPanel` 增加"图片存储位置"行（当前路径 + 更改 + 恢复默认）；切换时弹窗询问"是否迁移已有图片"——迁移则 Rust 移动文件 + 前端遍历 `canvasStore` 重写所有 `imagePath/outputImagePath` 绝对路径前缀；不迁移则旧图原地引用不受影响。

### 3. 预览性能优化
- Rust 缩略图管线：`image` crate 已有依赖；`save_image` 时同步生成 512px WebP 缩略图存 `cache/thumbs/`，新增 `ensure_thumbnail(path)` 对旧图按需补生成并落盘缓存。
- 节点数据新增 `outputThumbPath`；生图节点、Inspector、历史记录全部优先用缩略图，仅大图预览弹窗用原图。
- `OverlayNodeLayer` 增加视口裁剪：只渲染与可视区（含边距）相交的节点；单项抽成 memo 组件。
- 所有 `<img>` 加 `loading="lazy" decoding="async"`，图层容器加 `content-visibility` 优化。
- 生成成功且已落盘时清空节点数据中的 base64（`outputImage/outputImages`），只留路径，降低内存。

### 4. 模型列表实时获取
- Rust 新命令 `list_models(base_url, api_key, protocol)`：OpenAI 兼容→`GET /v1/models`；Google→`GET /v1beta/models`；Claude→`GET /v1/models`；统一返回规范化列表。
- 前端新建 `services/modelListService.ts`：按 provider 缓存（TTL 5分钟）+ 手动刷新，失败时回退预设列表并提示。
- `ModelSelector` 合并三个来源并加标签（实时/预设/自定义），`ProviderPanel` 增加"获取模型列表/测试连接"按钮。

## 阶段二：体验补全（参考 ComfyUI 队列 / Krea 变体 / Flora 节点探索；审批时可删减）

### 5. 生成队列与批量生成 【假设：做】
- 新建 `queueStore.ts`：任务（排队/运行中/成功/失败/已取消）+ 并发控制（默认2，可设置）；`useImageGeneratorExecution` 重构为纯执行函数供队列调用；UI 队列面板支持取消与失败重试；生图节点每次生成自动入队，关闭画布任务不丢。
- 批量：OpenAI 协议用原生 `n`；Gemini 协议循环 n 次拆成多个队列任务并发执行。

### 6. 画布交互增强 【假设：做】
- 生图节点直接显示结果缩略图（固定高度预览区），双击打开大图预览弹窗。
- 输出图可拖拽到画布空白处 → 自动创建"图片输入"节点并连线，方便继续编辑（变体工作流）。
- 节点右键菜单增加"以此图作为输入新建生图节点"。

### 7. 全局画廊 【假设：做】
- Rust `list_canvas_images` 泛化为可列全部画布图片；保存时元数据补充 `model` 字段（旧图显示为未知）。
- 侧边栏新增"画廊"视图（现有 canvases/nodes/prompts 之外第4个）：虚拟化网格、按画布/模型/时间筛选、点击看大图与当时提示词、拖回画布复用、"在文件夹中显示"。

## 阶段三（本次不做，列出备选项）
分组框（Frame）、常用参数预设保存、默认生成参数设置、Prompt 变量模板。如需要可在阶段二完成后继续。

## 验证与交付
- 每阶段：`tsc`（bun run build 内含）+ `cargo check` 通过；手工验证：生成→存储→缩略图→队列→画廊全链路、旧画布兼容加载、切换存储目录迁移。
- 同步更新 README 功能说明。

## 风险提示
- 视频/PPT 删除后旧画布中的相关节点会被静默过滤（toast 提示）。
- 旧图片首次显示时才补缩略图，首次浏览画廊会有一点点延迟。
- 需要修改 tauri asset scope 授权逻辑，若运行时 API 受限则回退为放宽配置文件中的 scope。