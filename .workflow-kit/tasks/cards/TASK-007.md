<!-- project-workflow: generated view; edit task JSON instead -->
# TASK-007 · API Key 不再明文落盘（REQ-007）：OS 凭据库存储、旧配置自动迁移、并封堵 Rust 侧明文回写路径

**状态**：done

**目标**：按已确认需求 REQ-007 让 API Key 不再以可直接读取的明文形式存放于 app-data.json：把供应商密钥改存到操作系统凭据库（Windows 凭据管理器，经 keyring crate），app-data.json 中只保留非敏感字段；旧版本已明文落盘的密钥在升级后自动迁移到凭据库并从磁盘副本中清除，且供应商仍然可用。同时封堵独立侦察实测发现的第二条明文路径：Google 协议的请求失败会把带 ?key=<密钥> 的 URL 拼进 Rust 错误字符串，该字符串经 node.data.error/errorDetails 回写并持久化到同一个 app-data.json —— 只加密 settings.providers 不足以满足验收标准，必须一并修掉。

**依赖**：TASK-003
**参考方案**：见 ../RESEARCH.md
**界面约定**：不涉及界面
**界面检查**：不适用
**修改范围**：src-tauri/Cargo.lock, src-tauri/Cargo.toml, src-tauri/src/gemini.rs, src-tauri/src/lib.rs, src-tauri/src/models.rs, src-tauri/src/secrets.rs, src/components/panels/ProviderPanel.tsx, src/services/imageGeneration/imageGenerationService.ts, src/services/llmService.ts, src/services/modelListService.ts, src/services/secretStore.ts, src/stores/settingsStore.ts, src/types/index.ts

## 验收标准

- app-data.json 中不再出现可直接读取的 API Key 明文。判定：真实应用保存一次后，读取 %APPDATA%\com.sy.nextcreator\app-data.json 全文，断言不存在任何供应商 apiKey 的原值（逐个 provider 的原密钥做 substring 搜索必须全部不命中）；且 next-creator-settings 内 providers[].apiKey 为空字符串或不存在。
- 密钥改存操作系统凭据库。判定：新增的 Tauri 命令可写入/读取/删除指定 provider 的密钥；真实应用写入后，凭据库中存在对应条目（用应用自身的读取命令回读可得到原值）；删除 provider 时对应条目被删除。
- 旧配置自动迁移且供应商仍可用。判定：构造一份旧格式 app-data.json（providers[].apiKey 为明文，模拟升级前状态），启动应用后断言：① 该明文密钥被写入凭据库；② 应用仍能取到密钥用于请求（供应商配置在 UI 与 getProviderConfig 路径上仍可用）；③ 迁移后再次保存，app-data.json 中不再含明文。迁移必须幂等：重复启动不产生重复条目、不丢密钥。
- 封堵 Rust 侧明文回写：Google 协议的请求失败错误字符串不得包含密钥。判定：对 gemini.rs / models.rs 中把请求 URL 拼进错误信息的位置做订正，使错误文本不含 ?key= 后的密钥；并以探针或单元验证证明「构造一个失败响应 → 返回的 error 字符串不含密钥明文」。
- 不把密钥写入任何文档、日志或任务文件。判定：全仓（含 .workflow-kit/ 与 evidence/）grep 不到任何真实密钥值；新增代码不打印密钥（已有的 gemini.ts 脱敏日志保持不变）；任务记录、提交信息与证据中只出现 <provider-id> 与非敏感字段。
- 未配置密钥时不改变现有行为：供应商未配置密钥时仍给出原有的「供应商 API Key 未配置」错误，不因改造而变成空指针或静默失败。
- 不改变 app-data.json 中其它字段的语义（画布、队列、自定义模型、主题、nodeProviders 映射），不改 UI 外观与交互；ProviderPanel 的密钥输入与掩码显示保持可用（编辑时能写入新密钥，不回显明文到日志）。
- node ./node_modules/typescript/bin/tsc --noEmit PASS（exit 0）；tsconfig.json 属受保护路径不得改动。
- node --experimental-strip-types scripts/queue-regression.mjs 保持 9/9 PASS exit 0（scripts/** 属受保护路径，本任务不得改动其中任何文件）。
- cargo build --release 成功（新依赖可获取、可编译）。若 cargo 无法拉取依赖则停止并报告，不得改用自研弱加密替代凭据库来绕过。
- 真实应用实机验证：release 构建 + vite devUrl + CDP 驱动，完成一次「配置供应商密钥 → 保存 → 重启 → 仍可用」的真实路径，并落盘前后截图或状态记录作为证据；同时给出迁移前后 app-data.json 的对比（脱敏，仅显示长度或是否存在，不显示密钥值）。

## 测试适用性

- 既有行为：按已确认需求变化
- 原始基线：PASS；本任务改变数据存储格式（用户已明确授权改变数据格式并配套迁移，见 REQ-007 的 description 与 DEC-defer-apikey-storage）。基线：项目无任何自动化测试套件；两条零依赖门禁为 tsc --noEmit 与 scripts/queue-regression.mjs（9 用例，TASK-003 收口后 9/9 PASS exit 0）。本任务新增 cargo build --release 作为第三条必需门禁，因为改动涉及 Rust 依赖与命令注册，前端门禁完全覆盖不到。已知限制：本机 vite build 曾因 esbuild spawn EPERM 无法运行，故前端构建以 release 应用实机验证替代；Windows 凭据管理器之外的平台（macOS Keychain / Linux Secret Service）本机无法验证，如实记录。
- 基线证据：.workflow-kit/tasks/evidence/RUN-852c12c4eafd4381ae91705c6ce1b19d-behavior-regression.stdout.txt
- 需求决定：DEC-defer-apikey-storage
- 保留：scripts/queue-regression.mjs 的 9 个用例（A 重启恢复 / B-F 重复入队与批量与并发与重试 / G 全局并发上限 / H 取消不写回 / I queued 标记保留）；它们保护 TASK-006 与 TASK-003 已验收的 REQ-001/002/005/006 行为；本任务不涉及这些路径，必须继续以同一命令同一判定标准运行，且脚本本身不得改动。；验证：behavior-regression
- 保留：tsc --noEmit 类型门禁；唯一既有的静态门禁，strict + noUnusedLocals + noUnusedParameters 全开；本任务改动跨 TS/Rust 边界与持久化格式，必须继续运行。；验证：typecheck
- 补充：Rust 构建（cargo build --release）；本任务引入新的 Rust 依赖（OS 凭据库）并注册新的 Tauri 命令；既有两条前端门禁结构上无法发现依赖不可获取、命令未注册或编译失败。TASK-003 已实测本机 cargo 能拉取 crates.io（旧记录的 schannel 阻塞已不成立）。；验证：cargo-build
- 替换：API Key 持久化格式与旧数据迁移；用户已明确授权改变数据格式并配套迁移（REQ-007 description）。旧行为：settingsStore.ts 的 partialize 把含 apiKey 的 settings.providers 全量写入 app-data.json（明文）。新行为：磁盘上不含密钥，密钥存 OS 凭据库，旧明文在升级时自动迁移并清除。该替换没有可自动断言的门禁（项目无可继承的自动化测试，且断言需要真实的 OS 凭据库与真实应用），因此映射到本任务新增的 cargo-build 必需门禁以保证新依赖与新命令真的可编译可注册，其余行为由实机验证覆盖。；验证：cargo-build

## 执行与恢复

- 首次开始：2026-09-29T12:19:42.366850Z
- 原截止时间：2026-09-29T15:19:42.366850Z
- 当前截止时间：2026-09-29T17:51:35.328823Z
- 时钟：按活动时间计：已用 199 分钟 / 额度 300 分钟（等待、断网和只读门禁不计）
- 已用修复轮：0
- 阻塞：无
- 下一步：继续已授权任务；所属功能完成后请用户验收

## 最近检查点

- 2026-09-29T15:55:05.029193Z：开始执行，保留原任务身份和截止时间；沿用本任务先前的范围基线，changed_files 为本任务累计改动；下一步：完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify
- 2026-09-29T15:55:05.854819Z：Out-of-scope changes: .workflow-kit/tasks/items/TASK-007.json (allowed: src-tauri/Cargo.lock, src-tauri/Cargo.toml, src-tauri/src/gemini.rs, src-tauri/src/lib.rs, src-tauri/src/models.rs, src-tauri/src/secrets.rs, src/components/panels/ProviderPanel.tsx, src/services/imageGeneration/imageGenerationService.ts, src/services/llmService.ts, src/services/modelListService.ts, src/services/secretStore.ts, src/stores/settingsStore.ts, src/types/index.ts)；下一步：核对 diff --run 列出的越界文件，撤销或用 unblock --note 说明归属后再 begin；不要新建任务或重置预算
- 2026-09-29T15:58:38.853739Z：阻塞已处置（scope）：核对：① 产品改动 9 个文件全部在 allowed_paths 内；受保护路径与 HEAD 一致；② 三道门禁通过：tsc exit 0、门禁 9/9 PASS、cargo build --release exit 0、cargo test 3 passed；③ 实机验证 6/6 PASS（真实凭据库），真实用户数据逐字节还原；④ 任务定义相对 prepare 冻结版的唯一差异是 allowed_paths 增补 Cargo.lock（Cargo.toml 新增依赖的自动产物），digest 已与修订后定义对齐（input.definition_digest == task_definition(task)）。重新 begin 生成新基线后 finish 不再受定义文件自身变更加干扰。；下一步：begin 重新实现
- 2026-09-29T15:58:40.085343Z：开始执行，保留原任务身份和截止时间；沿用本任务先前的范围基线，changed_files 为本任务累计改动；下一步：完成当前修改后运行 diff --run 核对改动，再调用 finish，然后 verify
- 2026-09-29T15:58:41.306254Z：编码结果已记录，差异范围已核对：无文件变化；下一步：运行 verify；代码完成尚未等于验收通过
- 2026-09-29T15:58:50.680899Z：预先定义的必需测试全部通过，日志已保存；下一步：审查当前候选；独立审查使用没有参与编码的新上下文
- 2026-09-29T17:37:34.823840Z：预先定义的必需测试全部通过，日志已保存；下一步：审查当前候选；独立审查使用没有参与编码的新上下文
- 2026-09-29T18:28:20.774179Z：当前候选的测试与审查通过（independent）；下一步：继续已授权任务；所属功能完成后请用户验收

## 原始证据

[唯一状态记录](../items/TASK-007.json)

- [RUN-1e097af82fe8481991285703bbf424bf](../runs/RUN-1e097af82fe8481991285703bbf424bf.json)
- [RUN-7841d3e46d8d4089be7d59f3086d0f88](../runs/RUN-7841d3e46d8d4089be7d59f3086d0f88.json)
- [RUN-1ed7fd67536c47da86b036f9cf599fe1](../runs/RUN-1ed7fd67536c47da86b036f9cf599fe1.json)
- [RUN-85ba9d61765a458080fd889d062d3611](../runs/RUN-85ba9d61765a458080fd889d062d3611.json)
- [RUN-f90ec6c5056b4f6489b2c44426662352](../runs/RUN-f90ec6c5056b4f6489b2c44426662352.json)
- [RUN-768ea51d55444269b289b1cd50488fd1](../runs/RUN-768ea51d55444269b289b1cd50488fd1.json)

卡片是自动生成的视图。Agent 修改任务记录、执行命令或保存检查点后重新生成；不手工把状态改成通过。
