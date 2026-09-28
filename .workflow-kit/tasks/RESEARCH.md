<!-- project-workflow: generated view; edit task JSON instead -->
# 参考方案调研

状态：searched

为第一批 A-D 四项改造检索可复用实现与真实约束：C 项需要 Tauri 2 的安全凭据存储方案；A 项需要可执行的验证门禁（本沙箱 vite/vitest 均不可用）；REQ-003 需要判断是否引入死代码检测工具。检索同时产出了两条改变结论的实测发现（partialize 死分支、零依赖 harness 可行）。

## REF-KEYRING · keyring crate（Rust 原生凭据库绑定）

- 来源：https://crates.io/crates/keyring
- 采用方式：dependency
- 适合之处：唯一无需用户主密码、直接落 OS 凭据库的方案：Windows 走 Credential Manager，macOS 走 Apple Keychain。crate 活跃（4.2.0，2026-08-29 发布）。本项目 Rust 侧已有 14 处 api_key IPC 参数（llm.rs:22,544,750,951 / gemini.rs:88,152,339,453 / dalle.rs:149,271 / models.rs:57,72,109,136），新增一个取密钥 command 的改动面可控。
- 限制：仅解决落盘明文，不消除密钥经 IPC 明文传给 Rust 的事实（要消除需改为 Rust 侧持有密钥、JS 只传 providerId，会改动上述全部签名，属更大范围）。keyring 4.x 相对 3.x 是破坏性 API 重构，网上多数示例仍是 3.x。Linux 需 libdbus，本项目只关心 Windows/macOS。当前环境 cargo 因 schannel TLS 失败无法拉包，本批内无法安装验证。
- 许可证：MIT OR Apache-2.0
- 固定版本：4.2.0
- 查验依据：crates.io API 直取 max_stable_version=4.2.0、发布日期 2026-08-29；仓库已迁移至 open-source-cooperative/keyring-rs；v4.1.3 曾被 yank、v4.1.4 紧急修复（已核验发布历史）。

## REF-STRONGHOLD · tauri-plugin-stronghold（官方加密 vault）

- 来源：https://crates.io/crates/tauri-plugin-stronghold
- 采用方式：rejected
- 适合之处：Tauri 官方 monorepo 维护，2026-09-26 发版，2.4.0 稳定。对需要加密文件 vault 的场景合适。
- 限制：对桌面轻应用过重：强制用户设置主密码（或自管密钥），非 OS 凭据库而是 IOTA Stronghold 加密文件；要求 Rust >= 1.90；官方 README 要求加 [profile.dev.package.scrypt] opt-level=3 规避上游构建 bug。本机 cargo 无法拉包，无法验证其能否编译。
- 许可证：MIT OR Apache-2.0
- 固定版本：2.4.0
- 查验依据：crates.io 直取 max_stable_version=2.4.0（另有 3.0.0-alpha.1）；官方仓库 2026-09-26 发版记录；README 中的 Rust 版本与 scrypt profile 要求已核验。弃用理由：强制主密码 + 构建 workaround，对单人桌面工具的用户体验成本高于 keyring。

## REF-TAURI-PLUGIN-KEYRING-HUAKUN · HuakunShen/tauri-plugin-keyring（社区插件）

- 来源：https://github.com/HuakunShen/tauri-plugin-keyring
- 采用方式：rejected
- 适合之处：直接封装 OS 凭据库且暴露为 Tauri 插件，若维护良好会比自建 command 更省事。
- 限制：基本停滞：最后一次 commit 2025-01-04，约 20 个月未更新，20 star。Cargo.toml 钉死 tauri = "2.1.0"（非 2.x 范围），本项目用 tauri =2.9.1，能否编译未能验证。npm 侧 tauri-plugin-keyring-api 仅 0.1.1。
- 许可证：MIT
- 固定版本：crate 0.1.0
- 查验依据：GitHub API 取得最后 commit 时间 2025-01-04、star 数 20；Cargo.toml 中 tauri = "2.1.0" 已读取。弃用理由：维护停滞且版本钉死，与 tauri 2.9.1 兼容性未验证。

## REF-TAURI-PLUGIN-STORE · tauri-plugin-store（本项目当前使用的持久化）

- 来源：https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/store
- 采用方式：reference_only
- 适合之处：本项目已有依赖（Cargo.toml 锁 =2.4.1），src/utils/tauriStorage.ts 统一封装，用于存放非敏感设置最合适。
- 限制：确认无任何加密能力：官方 README 与 v2 文档通篇无加密或密钥选项，只有 Store/LazyStore/autoSave。因此 API Key 明文落盘问题无法靠它解决，需配合 keyring 只把密钥移出。
- 许可证：MIT OR Apache-2.0
- 固定版本：2.4.0（本项目锁 2.4.1）
- 查验依据：官方文档与 README 已核验无加密选项；本项目 Cargo.toml 与 tauriStorage.ts 已读。结论用于界定改造边界：store 继续存非敏感设置，密钥另行处理。

## REF-NODE-STRIP-TYPES · Node.js 原生 TypeScript 剥离 + module.registerHooks（本项目验证门禁方案）

- 来源：https://nodejs.org/api/module.html#moduleregisterhooks
- 采用方式：adapt_code
- 适合之处：零新增依赖即可在无浏览器、无 Tauri 运行时的情况下加载并驱动真实业务代码。已实测：106ms 加载 src/stores/queueStore.ts，pump() 真实执行，job 从 queued→running→error；persist.rehydrate/hasHydrated 与 persist.getOptions().partialize 均可直接调用，故水合链路也能自动化测试。总控已独立复现（probe-queue-store.mjs 退出码 0）。
- 限制：需自写约 40 行 loader 解决四件事：@/ 别名、无扩展名相对导入补 .ts、stub @xyflow/react（必须在该层 stub，因 react-dom 内部 CJS require 无法被 hook 拦截）、stub globalThis.window（tauriStorage.ts:100 顶层 window.addEventListener）。需 Node >= 22.15；本项目本机 Node 24.19.0 满足，但 CI 与 tauri.conf 用 bun，bun 兼容性未核验。项目中无 enum/装饰器/namespace（已 grep 确认 0 命中），故 --experimental-strip-types 的语法限制不构成阻碍。
- 许可证：MIT（Node.js）
- 固定版本：Node 24.19.0（本机实测）
- 查验依据：总控独立复现：node --experimental-strip-types .workflow-kit/tasks/evidence/probe-queue-store.mjs 退出码 0，输出 IMPORT OK / enqueue->running / clamp(99)=4，并复现 REQ-001（遗留 queued 任务 250ms 无变化，显式 pump 后转 error）。另 probe-partialize-deadbranch.mjs 证明 partialize 恒不输出 running。

## REF-VITEST · Vitest（评估后不采用）

- 来源：https://vitest.dev/
- 采用方式：rejected
- 适合之处：生态标准测试框架，若可用是最省心的长期选择。
- 限制：在本环境不可用：vitest/vite 的转译依赖 esbuild，而 esbuild 的 JS API transform() 直接抛 Error: spawn EPERM（node_modules/esbuild/lib/main.js:1978），与 vite build 失败同根因（沙箱限制子进程管道 stdio）。且 npm 安装亦受阻（npm cache open EPERM）。node_modules 中无 vitest/jest/jsdom/happy-dom。
- 许可证：MIT
- 固定版本：未安装（无法核验版本）
- 查验依据：实测 esbuild JS API 抛 spawn EPERM；cmd /c npm view knip 返回 npm error code EPERM（cache 路径）；node_modules 包清单已核实无测试框架。弃用理由：环境层面无法运行，非配置问题。

## REF-KNIP · knip（死代码与未使用导出检测）

- 来源：https://knip.dev/
- 采用方式：rejected
- 适合之处：活跃维护（6.38.0），自动读取 tsconfig paths 故支持本项目 @/* 别名，动态 import() 计入依赖图。有 --include files 与 --no-exit-code 可做只看文件级、report-only 的低噪音运行。
- 限制：本批次技术上无法落地：依赖 oxc-parser/jiti 等，而 npm 安装因 EPERM 受阻。且引入成本对仅 2 个死文件偏高——首次运行因 entry 未覆盖会产生级联误报。更关键的是它抓不到本项目真正有价值的死代码类型：queueStore.ts:217-226 是模块内逻辑不可达分支，而 knip/ts-prune 只报未使用导出与文件；tsc 的 allowUnreachableCode 也抓不到（非语法不可达而是 data-flow 不可达）。已核验其动态 import 相关 issue（#556/#688/#1368/#1544）。
- 许可证：ISC
- 固定版本：6.38.0（未能安装）
- 查验依据：npm registry API 取得版本 6.38.0 与 engines 要求；GitHub issues #556/#688/#1368/#1544 已核验；knip.dev/reference/cli 确认 --include/--no-exit-code 存在。弃用理由：本批无法安装，且覆盖不到本项目最需要发现的死分支类型，性价比不足。改为直接删除两个死文件 + 用零依赖探针锁定死分支。

## REF-COMFYUI · ComfyUI（节点式生成工具的队列与状态机制参考）

- 来源：https://docs.comfy.org/development/comfyui-server/comms_routes
- 采用方式：reference_only
- 适合之处：同类可视化节点生成工具中最有完整官方 API 文档者。可借鉴的具体机制：typed-socket DAG；POST /prompt 返回 prompt_id 与队列位次或结构化 node_errors；GET /queue 区分 queue_running 与 queue_pending；POST /api/jobs/{id}/cancel 幂等（对已结束或未知 id 返回 200 + {cancelled:false}），批量取消先校验全部 id 再执行；通过 WebSocket /ws 推送 execution_start/progress/executing 等状态消息。
- 限制：客户端-服务器架构与本项目单机 Tauri 应用不同，其 HTTP API 与 WebSocket 推送不可直接照搬；本项目无常驻服务端。仅作机制参考。
- 许可证：GPL-3.0
- 固定版本：master（server.py 已核验）
- 查验依据：官方文档 comms_routes 与 comms_messages 已抓取；GitHub server.py 源码已核验。/queue、/interrupt、幂等 cancel 与 WebSocket 消息名均为文档与源码确认。

## REF-INVOKEAI · InvokeAI（多任务调度与进度呈现参考）

- 来源：https://github.com/invoke-ai/InvokeAI/releases
- 采用方式：reference_only
- 适合之处：节点工作流编辑器与画布并存，两者共享生成后端——与本项目 flowStore（节点图）与 canvasStore（画布）并存的形态相似。可借鉴：多 GPU 时多个排队任务并行执行并把预览区分割成 tile 显示各自进度；多用户下轮转调度；session queue 概念与批量取消（v6.14.0 发布说明）。
- 限制：其多 GPU 与多用户调度前提在本项目不成立（单机单用户），轮转与 tile 预览的机制不适用。仅借鉴 session queue 与批量取消的概念。
- 许可证：Apache-2.0
- 固定版本：v6.14.2（2026-09-27）
- 查验依据：GitHub releases 页面已抓取，v6.14.0 发布说明中的并行执行、tile 预览分割、轮转调度与批量取消均已核验。

## REF-KREA-FLORA-RUNWAY · Krea / Flora / Runway（未取得可引用来源）

- 来源：https://www.krea.ai/
- 采用方式：rejected
- 适合之处：同类商业产品，本可用于横向对照其节点交互与队列呈现。
- 限制：未能取得可引用来源：Krea 帮助中心与 Runway help 返回 404/403（Cloudflare 拦截），Flora 首页仅返回标语、无可核验的队列机制描述。因此其具体机制不可引用，后续 UI 计划中不应声称借鉴了这些产品的具体实现。
- 许可证：unknown
- 固定版本：未取得
- 查验依据：三次抓取尝试均失败（404/403 与无实质内容），如实记录为不可引用，避免后续计划编造来源。
