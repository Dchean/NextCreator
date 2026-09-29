/**
 * 供应商 API Key 的唯一读写通道（REQ-007）
 *
 * 背景：此前密钥由 `settingsStore` 的 persist 直接明文写入 `app-data.json`
 * （`providers[].apiKey`），任何本地进程都能读到。REQ-007 要求"不再以可直接读取的明文形式
 * 存放于 app-data.json"，并要求旧配置升级后自动迁移、供应商仍可用。
 *
 * 设计：
 *   · 密钥存在**操作系统凭据库**里（Windows 凭据管理器 / macOS Keychain / Linux Secret
 *     Service），经 Rust 命令 `set/get/delete_provider_secret` 读写；磁盘上只留非敏感字段。
 *   · 本模块是前端**唯一**的密钥读写入口。取密钥一律走 `getProviderApiKey()`，
 *     不要从 settings 里读 `provider.apiKey`（那里在迁移后是空字符串）。
 *   · 内存缓存：凭据库读取是 IPC 往返，而一次生成可能多次取同一供应商的密钥（构造请求、
 *     刷新模型列表等）。缓存以 provider id 为键，写/删时同步更新，避免同一进程内取到旧值。
 *     缓存**不落盘**，进程结束即消失。
 *
 * 安全约定：本模块不打印密钥内容；错误信息只带 provider id 与失败原因。
 * 不把密钥写入任何文档、日志或任务文件。
 */

import { invoke } from "@tauri-apps/api/core";

/** 进程内缓存：provider id → 密钥。仅存在于内存，随进程结束消失。 */
const cache = new Map<string, string>();

/** 缓存"该 provider 已确认无密钥"，避免对同一缺失项反复 IPC。 */
const knownMissing = new Set<string>();

/**
 * 已经**确认写入凭据库**的 provider id。
 *
 * 这是防丢密钥的安全阀（settingsStore 的持久化闸门会读它）：密钥只有在确认已进凭据库之后，
 * 才允许从磁盘明文转为"不落盘"。否则宁可把明文留在磁盘 —— 抹掉而凭据库里又没有，
 * 密钥就**永久丢失**，用户只能重新申请。安全目标（磁盘无明文）与数据安全冲突时，
 * 数据安全优先，并让用户看到可见提示。
 */
const persistedInKeyring = new Set<string>();

/** 该 provider 的密钥是否已确认存进凭据库（同步读取，供持久化闸门使用）。 */
export function isApiKeyPersistedInKeyring(providerId: string): boolean {
  return persistedInKeyring.has(providerId);
}

/**
 * 登记"该 provider 的密钥已确认在凭据库里"。
 *
 * 什么时候必须调用（缺了就会重新把明文写回磁盘，见 settingsStore.partialize）：
 *   · setProviderApiKey 成功后（写路径自动置位）；
 *   · **读取路径**：getProviderApiKey 从凭据库读到了值 —— 这一条由 settingsStore 的回填
 *     路径在写入内存后调用，否则回填的 setState 会因为例外分支未置位而把明文重新落盘
 *     （独立审查 r1 的 F1，critical）。
 * 显式拆成独立函数而不是在读路径里顺手置位，是为了让"确认"这个动作在调用点上可见、
 * 可审查；读取到值即确认存在，语义等价于写入成功。
 */
export function markPersistedInKeyring(providerId: string): void {
  if (!providerId) return;
  persistedInKeyring.add(providerId);
}

function isMissingSecretError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // 后端把 keyring 的 NoEntry 映射为 Ok(None)，正常不会走到这里；
  // 这里只兜底"命令未注册/运行时不可用"这类环境问题，让调用方能优雅降级。
  return message.includes("NoEntry") || message.includes("not found");
}

/**
 * 写入（或覆盖）某供应商的密钥。
 * 空字符串表示删除该条目（与后端语义一致），不会存成空密钥。
 */
export async function setProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  await invoke("set_provider_secret", { providerId, secret: apiKey });
  if (apiKey) {
    cache.set(providerId, apiKey);
    knownMissing.delete(providerId);
    persistedInKeyring.add(providerId);
  } else {
    cache.delete(providerId);
    knownMissing.add(providerId);
    persistedInKeyring.delete(providerId);
  }
}

/**
 * 读取某供应商的密钥；未配置时返回空字符串。
 *
 * 注意：读取失败（凭据库不可用）与"未配置"在这里**都**返回空字符串 —— 调用方（
 * imageGenerationService / llmService）已有的空值检查会给出「供应商 API Key 未配置」，
 * 保持改造前的用户可见行为。真实失败原因会打到 console.warn，便于排查。
 */
export async function getProviderApiKey(providerId: string): Promise<string> {
  if (!providerId) return "";
  const cached = cache.get(providerId);
  if (cached !== undefined) return cached;
  if (knownMissing.has(providerId)) return "";
  try {
    const secret = await invoke<string | null>("get_provider_secret", { providerId });
    if (secret) {
      cache.set(providerId, secret);
      return secret;
    }
    knownMissing.add(providerId);
    return "";
  } catch (error) {
    if (!isMissingSecretError(error)) {
      console.warn("[secretStore] 读取凭据库失败（该项按未配置处理）:", error);
    }
    knownMissing.add(providerId);
    return "";
  }
}

/** 删除某供应商的密钥（删除 provider 时调用）。删除是幂等的。 */
export async function deleteProviderApiKey(providerId: string): Promise<void> {
  cache.delete(providerId);
  knownMissing.add(providerId);
  await invoke("delete_provider_secret", { providerId });
}

/**
 * 迁移用：批量把"旧的明文密钥"搬进凭据库。
 *
 * 幂等性由调用方保证（只在检测到磁盘上仍有明文时调用）；本函数只负责搬运，
 * 任一条失败都不影响其它条 —— 失败项会被跳过并如实上报，绝不静默丢数据。
 * 返回成功迁移的 provider id 列表。
 */
export async function migratePlaintextApiKeys(
  entries: Array<{ id: string; apiKey: string }>
): Promise<{ migrated: string[]; failed: string[] }> {
  const migrated: string[] = [];
  const failed: string[] = [];
  for (const entry of entries) {
    if (!entry.id || !entry.apiKey) continue;
    try {
      await setProviderApiKey(entry.id, entry.apiKey);
      migrated.push(entry.id);
    } catch (error) {
      // 迁移失败必须保留原密钥（不丢数据）：调用方据此保留磁盘上的明文并提示用户。
      console.warn("[secretStore] 迁移密钥失败，保留原值:", entry.id, error);
      failed.push(entry.id);
    }
  }
  return { migrated, failed };
}

/** 仅供测试/门禁复位内存缓存；产品代码不应调用。 */
export function resetSecretCache(): void {
  cache.clear();
  knownMissing.clear();
}
