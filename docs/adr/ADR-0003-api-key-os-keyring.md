# ADR-0003：API Key 改用操作系统凭据库存储，并封堵 Rust 侧明文回写

状态：accepted。用户/管理角色决定依据：`DEC-defer-apikey-storage`（推迟理由已失效）、REQ-007 的 description（用户已明确授权改变数据格式并配套迁移）与验收标准。适用模块：`src/stores/settingsStore.ts`、新增 `src/services/secretStore.ts`、`src/components/panels/ProviderPanel.tsx`、`src/services/{imageGeneration/imageGenerationService,llmService,modelListService}.ts`、新增 `src-tauri/src/secrets.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/gemini.rs`、`src-tauri/src/models.rs`、`src-tauri/Cargo.toml`。

## Problem

REQ-007：`settingsStore.ts` 的 persist `partialize` 返回整个 `settings`，其中 `providers[].apiKey` 被**原样明文**写入 `app-data.json`。项目全仓零加密（grep `encrypt|cipher|keyring|stronghold|safeStorage|crypto.subtle` 无命中），任何本地进程都能直接读到密钥。

独立侦察（TASK-007 准备阶段，只读）另发现**第二条明文路径**，它使"只加密 settings.providers"不足以满足验收：

1. `src-tauri/src/gemini.rs` 把密钥拼进请求 URL 的查询串（`?key={}`）。
2. 请求失败时该文件用 `format!("请求失败: {}", e)` 格式化 reqwest 错误，而 reqwest 0.12 的 `Display for Error` 会把完整 URL（**含查询串**）追加为 ` for url (...)`。
3. 该字符串成为 `GeminiResult.error` → `gemini.ts` 转成 `{error, errorDetails}` → `imageGenerationExecution` / `nodeExecutor` 写入 `node.data.error` 与 `errorDetails` → 随画布持久化进**同一个** `app-data.json`。
4. 同一模式还在 `gemini.rs` 的文本路径与 `models.rs` 的三处 URL 中出现；`println!` 还会把带密钥的 URL 打到 stdout。

侦察以独立探针实测确认：失败分支产出的 error 字符串里 `?key=SUPERSECRETKEY123` 原样可见（`contains secret: true`）。注意 `dalle.rs` 与 `llm.rs` 走 `Authorization`/`x-api-key` **头**，reqwest 的 Display 不包含头部，故不受影响 —— 这是 Google 协议特有的泄漏。

## Proposal

1. **密钥移出磁盘明文**：新增 Rust 命令（`secrets.rs`），以 `keyring` crate 写入/读取/删除操作系统凭据库（Windows 凭据管理器；macOS Keychain / Linux Secret Service 同 API）。`app-data.json` 只保留非敏感字段，`providers[].apiKey` 在磁盘上为空。
2. **前端经 IPC 读写密钥**：新增 `src/services/secretStore.ts` 作为唯一封装，密钥按 provider id 存取；`imageGenerationService` / `llmService` / `modelListService` 取密钥时改为向该封装请求（而不是从 settings 读），从而"磁盘无明文"与"请求仍可用"同时成立。
3. **旧配置自动迁移且幂等**：`settingsStore` 水合后检测 `providers[].apiKey` 为非空明文 → 写入凭据库 → 清空内存与磁盘副本。迁移必须幂等（重复启动不重复写、不丢密钥），且必须在"UI 仍显示该供应商已配置"这一可观察行为上保持连续。
4. **封堵 Rust 侧回写**：把 `gemini.rs` / `models.rs` 中会携带 URL 的错误格式化改为不含查询串的形式（例如 `e.without_url()`，或只按 `is_timeout`/`is_connect` 分类输出），并让 `println!` 不打印含密钥的 URL。

## Alternatives considered

- **自研加密（AES + 本地密钥）**：rejected。解密密钥必须与密文同机可取，等于把锁和钥匙放在一起；达不到"不再以可直接读取的明文形式存放"的实质目标。
- **只做混淆/Base64**：rejected，同上，属伪装而非保护。
- **`tauri-plugin-stronghold`**：rejected。它面向需要密码解锁的加密保险库，要求用户额外输入主密码，与本项目"个人工具、无感使用"的定位冲突；`keyring` 直接复用操作系统登录凭据，无额外交互。
- **只加密 `settings.providers`，不修 Rust 错误文本**：rejected。侦察已实测第二条路径会把明文写进同一个 `app-data.json`，验收标准（"不再以可直接读取的明文形式存放于 app-data.json"）将不成立。

## Consequences

- 引入一个 Rust 依赖（`keyring`）与一条新的 IPC 边界；`Cargo.lock` 变化，构建时间增加。
- **旧记录的门禁阻塞已失效**：`DEC-defer-apikey-storage` 推迟 REQ-007 的理由是"cargo 因 schannel TLS 凭证失败无法拉包"。TASK-003 期间已实测本机 cargo 可正常拉取 crates.io（`cargo add --dry-run keyring` 解析出 keyring 4.2.0，HEAD 请求 200）。因此该推迟理由不再成立，本 ADR 据此取代它。
- 凭据库条目在用户删除供应商时必须同步清理，否则残留；删除路径需与新增路径一并实现与验证。
- 迁移只在升级后的首次启动发生；迁移失败时必须保留原密钥（不丢数据）并向用户给出可见提示，不得静默丢弃。
- 不覆盖 macOS / Linux 的实机验证（本机为 Windows），该限制如实记录，不宣称已在那些平台验证。
