# ADR-0002：以 Node 原生能力建立零依赖行为回归门禁

状态：accepted。用户/管理角色决定依据：`DEC-zero-dep-verification`。适用模块：新增 `scripts/queue-regression.mjs` 与 `package.json` 中的 script 条目。

## Problem

本项目在改造前**没有任何自动化行为测试**：0 个测试文件、0 个 lint 配置、Rust 侧 3035 行 0 个 `#[test]`；唯一 CI（`.github/workflows/release.yml`）只在推 `v*` tag 时触发，且没有独立的 typecheck / lint / test 步骤。

唯一现存的自动化保护是 `tsc --noEmit`（strict + noUnusedLocals + noUnusedParameters 全开，当前零诊断）。但门禁存在**已被实证的盲区**：`src/services/imageService.ts`（312 行）与 `src/utils/imageCompression.ts`（81 行）共 393 行零外部引用，而 `tsc` 依然 PASS —— 因为整模块死代码没有未使用的局部变量，只是无人 import。

因此本轮修复 REQ-001 / REQ-002 若只靠 `tsc` 与人工点击，无法提供"修复前失败、修复后通过"的可执行证据。

环境约束（均已实测）：

- `vite build` 在本会话沙箱失败：esbuild 配置打包时 `Error: spawn EPERM`（子进程管道 stdio 受限）。
- **vitest 同样不可用**：其转译依赖 esbuild，而 esbuild 的 JS API `transform()` 直接抛 `spawn EPERM`（`node_modules/esbuild/lib/main.js:1978`），与 `vite build` 同根因。
- `npm` 在默认 cache 路径下报 `EPERM`，改用工作区内 `--cache` 后可用。
- `cargo` 因 schannel TLS 凭证失败（`SEC_E_NO_CREDENTIALS`）无法拉包，换 `CARGO_HOME` 也失败。

## Proposal

不引入任何需要安装的测试框架。改用 **Node 24 原生能力**建立行为门禁：

```
node --experimental-strip-types scripts/queue-regression.mjs
```

原理：`node:module` 的 `registerHooks()` 提供 resolve/load 钩子，配合 `--experimental-strip-types` 直接加载并执行真实的 `src/**/*.ts`，无需转译器、无浏览器、无 Tauri 运行时。

**已实测证明可行**（`probe-queue-store.mjs`，退出码 0）：

```
IMPORT OK
initial -> {"jobs":0,"concurrency":2,"paused":false}
enqueue -> running
after pump -> error | 节点不存在
clamp(1) -> 1
clamp(99) -> 4
```

`pump()` 真实执行，job 正常流转 `queued → running → error`。`persist.rehydrate` / `persist.hasHydrated` / `persist.getOptions().partialize` 均为公开 API（已实测为 function），故**水合链路本身也可自动化测试**，覆盖面大于仅测 store 方法。

脚本需在 loader 中解决四件事（均已定位并复现）：

1. **`@/` 路径别名**：映射到 `src/`。
2. **无扩展名的相对导入**（如 `imageGeneration/index.ts` → `./imageGenerationService`）：补 `.ts`。**注意**：补全只能对父模块为 `.ts`/`.tsx` 的请求生效，否则会破坏 `react/index.js` → `./cjs/react.development.js` 的 CJS 解析。
3. **stub `@xyflow/react`**：`flowStore.ts` 顶层 import 它，不 stub 会报 `SyntaxError: The requested module 'react/jsx-runtime' does not provide an export named 'Fragment'`。**关键**：react-dom 的 CJS 内部 `require` 不会被 ESM hook 拦截，因此 stub 必须做在 `@xyflow/react` 这一层，只 stub `react-dom` 无效。
4. **stub `globalThis.window`**：`tauriStorage.ts:100` 有顶层 `window.addEventListener("beforeunload", ...)`。

同时需 stub `@tauri-apps/api/*` 与 `@tauri-apps/plugin-*`（plugin-store 返回 null 即可）。

附带发现：`components/nodes/imageGeneratorConfig.ts` 的前三个 import **全是 `import type`**，运行时被完全擦除，故 `queueStore` 的实际运行时依赖链比静态阅读预期短得多。

断言要求：断言对象必须是需求描述的可观察行为（重启后 job 不停留 `queued`；重复触发不新增 job），**不得**断言内部变量、私有函数或调用顺序。用例必须能覆盖修复前后的差异，即具备红→绿能力。

## Alternatives considered

- **引入 vitest**：生态标准、长期最省心。但本环境**物理上跑不起来**（esbuild `spawn EPERM`），且 `npm install` 默认受阻。记录为 rejected（见 `tasks/RESEARCH.md` 的 `REF-VITEST`）。若将来环境恢复，可平滑迁移——loader 方案与 vitest 的用例语义一致。
- **引入 knip 检测死代码**：无法安装（依赖 `oxc-parser`），且**覆盖不到本项目最有价值的死代码类型**——`queueStore.ts:217-226` 是 data-flow 不可达的模块内分支，而 knip/ts-prune 只报未使用的导出与文件；`tsc` 的 `allowUnreachableCode: false` 也抓不到（它并非语法不可达）。记录为 rejected（`REF-KNIP`）。
- **只用 `tsc` + 人工回归**：零改动。但无法提供红→绿证据，且已验证 `tsc` 抓不到整模块死代码与逻辑死分支。否决。
- **不做自动化，纯人工 5 条路径回归**：可作为补充，但不能替代可执行证据。

## Consequences

收益：以零新增依赖获得可执行的行为回归证据；REQ-001 的根因（不可达分支）能被测试锁定，防止复发；为后续更大改造（双画布合并、执行链统一）提供可扩展的测试底座。

代价与风险：
- 需自维护约 40 行 loader 代码，包含 4 个易错的解析规则（尤其"仅对 .ts 父模块补扩展名"与"必须 stub `@xyflow/react` 而非 react-dom"）。
- 依赖 Node `>= 22.15`（`registerHooks`）。本机 Node 24.19.0 满足；但 CI 与 `tauri.conf.json` 实际使用 **bun**，bun 对此方案的兼容性**未核验**——若将来在 CI 中启用，需先验证。
- 使用 `--experimental-strip-types` 属实验特性，Node 版本升级可能改变行为。项目当前无 enum / 装饰器 / namespace（已 grep 确认），故语法限制暂不构成阻碍；将来若引入 enum 需改用 `--experimental-transform-types`。
- 该项目方案的**验证范围有限**：只证明 store 级逻辑，不证明真实 Tauri 运行时、HTTP 供应商调用、渲染与真实 UI 行为。不得用它替代人工验收。
- 回滚：删除脚本与 script 条目即可，不影响业务代码。

后续维护：stub 列表需随新增的 Tauri 插件与顶层副作用同步更新；一旦某次改动使脚本因 stub 缺失而失败，应补 stub 而不是放宽断言。
