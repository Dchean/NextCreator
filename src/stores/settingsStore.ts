import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AppSettings, SettingsState, Provider, NodeProviderMapping, ProviderProtocol } from "@/types";
import { tauriStorage } from "@/utils/tauriStorage";
// REQ-007：持久化闸门需要知道"哪些密钥已确认进了系统凭据库"，只有凭据库里确认有值，
// 磁盘上的明文才允许被清空（否则宁可保留明文也不丢密钥，见 partialize 的说明）。
import { isApiKeyPersistedInKeyring } from "@/services/secretStore";

// 默认设置
const defaultSettings: AppSettings = {
  providers: [],
  nodeProviders: {},
  theme: "light",
};

// 数据迁移：为旧版供应商数据添加 protocol 字段并处理 baseUrl
function migrateProviders(providers: Provider[]): Provider[] {
  return providers.map((provider) => {
    // 如果已经有 protocol 字段，无需迁移
    if (provider.protocol) {
      return provider;
    }

    // 检测并处理 baseUrl 中的版本路径后缀
    let baseUrl = provider.baseUrl || "";
    let protocol: ProviderProtocol = "google";  // 默认使用 Google 协议

    // 仅移除标准版本路径后缀（/v1beta, /v1），保留其他特殊路径
    if (baseUrl.match(/\/v1(beta)?$/)) {
      baseUrl = baseUrl.replace(/\/v1(beta)?$/, "");
    }

    // 移除末尾斜杠
    baseUrl = baseUrl.replace(/\/+$/, "");

    return {
      ...provider,
      baseUrl,
      protocol,
    };
  });
}

interface SettingsStore extends SettingsState {
  // 基础设置
  updateSettings: (settings: Partial<AppSettings>) => void;
  resetSettings: () => void;
  openSettings: () => void;
  closeSettings: () => void;

  // 供应商 CRUD
  addProvider: (provider: Omit<Provider, "id">) => string;
  updateProvider: (id: string, updates: Partial<Omit<Provider, "id">>) => void;
  removeProvider: (id: string) => void;
  getProviderById: (id: string) => Provider | undefined;

  // 节点供应商映射
  setNodeProvider: (nodeType: keyof NodeProviderMapping, providerId: string | undefined) => void;
  getNodeProvider: (nodeType: keyof NodeProviderMapping) => Provider | undefined;

  // 供应商面板状态
  isProviderPanelOpen: boolean;
  openProviderPanel: () => void;
  closeProviderPanel: () => void;
}

// 生成唯一 ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      settings: defaultSettings,
      isSettingsOpen: false,
      isProviderPanelOpen: false,

      updateSettings: (newSettings) =>
        set((state) => ({
          settings: { ...state.settings, ...newSettings },
        })),

      resetSettings: () =>
        set({ settings: defaultSettings }),

      openSettings: () =>
        set({ isSettingsOpen: true }),

      closeSettings: () =>
        set({ isSettingsOpen: false }),

      // 供应商 CRUD
      // REQ-007：内存里的 apiKey 保留真实密钥（凭据库回填 / 调用方写入），
      // 落盘时由 partialize 统一清空 —— 那是防止明文进磁盘的最后一道闸门。
      // 因此这里**不**改写 apiKey：改写会把内存里的真实密钥也丢掉。
      addProvider: (provider) => {
        const id = generateId();
        set((state) => ({
          settings: {
            ...state.settings,
            providers: [...state.settings.providers, { ...provider, id }],
          },
        }));
        return id;
      },

      updateProvider: (id, updates) =>
        set((state) => ({
          settings: {
            ...state.settings,
            providers: state.settings.providers.map((p) =>
              p.id === id ? { ...p, ...updates } : p
            ),
          },
        })),

      removeProvider: (id) => {
        // REQ-007：删除供应商时同步清理凭据库条目，避免在系统里残留密钥。
        // 删除是异步的且失败不应阻断 UI（磁盘上本来就没有密钥），故只告警。
        void import("@/services/secretStore")
          .then(({ deleteProviderApiKey }) => deleteProviderApiKey(id))
          .catch((error) => {
            console.warn("[settingsStore] 清理凭据库条目失败:", error);
          });
        set((state) => {
          // 移除供应商时，同时清除相关的节点映射
          const newNodeProviders = { ...state.settings.nodeProviders };
          for (const key of Object.keys(newNodeProviders) as (keyof NodeProviderMapping)[]) {
            if (newNodeProviders[key] === id) {
              delete newNodeProviders[key];
            }
          }

          return {
            settings: {
              ...state.settings,
              providers: state.settings.providers.filter((p) => p.id !== id),
              nodeProviders: newNodeProviders,
            },
          };
        });
      },

      getProviderById: (id) => {
        return get().settings.providers.find((p) => p.id === id);
      },

      // 节点供应商映射
      setNodeProvider: (nodeType, providerId) =>
        set((state) => ({
          settings: {
            ...state.settings,
            nodeProviders: {
              ...state.settings.nodeProviders,
              [nodeType]: providerId,
            },
          },
        })),

      getNodeProvider: (nodeType) => {
        const state = get();
        const providerId = state.settings.nodeProviders[nodeType];
        if (!providerId) return undefined;
        return state.settings.providers.find((p) => p.id === providerId);
      },

      // 供应商面板状态
      openProviderPanel: () =>
        set({ isProviderPanelOpen: true }),

      closeProviderPanel: () =>
        set({ isProviderPanelOpen: false }),
    }),
    {
      name: "next-creator-settings",
      storage: createJSONStorage(() => tauriStorage),
      /**
       * REQ-007：**磁盘上默认不落密钥明文**。
       *
       * 内存里的 `provider.apiKey` 仍保留真实密钥（启动时从 OS 凭据库回填，见下方迁移逻辑），
       * 这是为了让既有同步读取方（如 ModelSelector 的自动拉取门控、imageGenerationService /
       * llmService / modelListService 的既有实现）继续工作，避免一次大范围的异步化改造。
       * 持久化是最后一道闸门：无论谁往 settings 里写了什么，落盘前都会被清空。
       *
       * 例外（**数据安全优先于安全目标**）：若该供应商的密钥**尚未确认写入凭据库**
       * （迁移/保存失败，例如系统凭据库不可用），这里会**保留明文** ——
       * 抹掉而凭据库里又没有，密钥就永久丢失，用户只能重新申请。
       * 此时用户会看到 toast 提示，且下次启动会再次尝试迁移。
       */
      partialize: (state) => ({
        settings: {
          ...state.settings,
          providers: state.settings.providers.map((provider) =>
            provider.apiKey && !isApiKeyPersistedInKeyring(provider.id)
              ? provider
              : { ...provider, apiKey: "" }
          ),
        },
      }),
      // 数据迁移：在 store 恢复时执行
      onRehydrateStorage: () => {
        return (state, error) => {
          if (error) {
            console.error("[settingsStore] 数据恢复失败:", error);
            return;
          }
          if (!state || state.settings.providers.length === 0) return;

          // 迁移 1（既有）：为旧版供应商数据添加 protocol 字段并处理 baseUrl
          const migratedProviders = migrateProviders(state.settings.providers);
          const needsMigration = migratedProviders.some((p, i) => {
            const original = state.settings.providers[i];
            return p.protocol !== original.protocol || p.baseUrl !== original.baseUrl;
          });
          if (needsMigration) {
            console.log("[settingsStore] 执行供应商数据迁移");
            state.updateSettings({ providers: migratedProviders });
          }

          // 迁移 2（REQ-007）：把密钥从磁盘搬进 OS 凭据库，并在内存里回填真实密钥。
          //
          // 两种来源都要处理，缺一不可：
          //   a) **旧版升级**：磁盘上带明文 apiKey（改造前的遗留数据）→ 先写进凭据库。
          //   b) **已迁移后的正常启动**：磁盘上 apiKey 为空，但凭据库里有 → 读回内存。
          //
          // 顺序刻意是"先 a 后 b"，这样升级用户的密钥在同一个启动周期内既完成了迁移又完成了回填。
          // 幂等性：a 只在"磁盘仍有明文"时执行，迁移完成并回写后磁盘上不再有明文，下次启动只走 b；
          // b 的回填是按 provider id 逐个 set，重复执行结果一致。
          // 失败处理：任何一步失败都**不丢数据** —— a 失败则磁盘明文保留待下次重试，
          // b 失败则该 provider 视作未配置（与"密钥还没配过"走同一提示路径）。
          const snapshot = state.settings.providers;
          const plaintext = snapshot.filter((p) => Boolean(p.apiKey));
          // 迁移成功项不需要回填（内存里已有真实密钥）；只有没迁移成功的才尝试从凭据库回填。
          const migratedIds = new Set<string>();
          void import("@/services/secretStore")
            .then(async ({ migratePlaintextApiKeys, getProviderApiKey, markPersistedInKeyring }) => {
              if (plaintext.length > 0) {
                const { migrated, failed } = await migratePlaintextApiKeys(
                  plaintext.map((p) => ({ id: p.id, apiKey: p.apiKey }))
                );
                for (const id of migrated) {
                  migratedIds.add(id);
                  // F1/F2 修复：迁移成功即确认该密钥已在凭据库 —— partialize 的例外分支
                  // 才允许对它清空。置位必须在**任何**写盘发生之前完成。
                  markPersistedInKeyring(id);
                }
                if (failed.length > 0) {
                  const { useToastStore } = await import("@/stores/toastStore");
                  useToastStore
                    .getState()
                    .warning(
                      `${failed.length} 个供应商的密钥未能迁移到系统凭据库；密钥已保留在本地配置中、功能不受影响，请检查系统凭据库后重启应用以重试`
                    );
                }
                if (migrated.length > 0) {
                  console.log(`[settingsStore] 已把 ${migrated.length} 个供应商密钥迁移到系统凭据库`);
                  // 注意：这里**不清空**内存里的 apiKey —— partialize 已经保证落盘时不含密钥，
                  // 而内存里的真实密钥正是"供应商仍可用"的来源（ModelSelector 门控、请求构造都读它）。
                }
              }

              // b) 回填内存：凭据库里有值、而内存（来自磁盘）为空 → 写回。
              //    这一步让"磁盘无明文"与"请求/UI 仍可用"同时成立。
              //    （迁移成功的项内存里已有明文，此处会跳过。）
              const backfill: Partial<Record<string, string>> = {};
              for (const provider of snapshot) {
                if (provider.apiKey || migratedIds.has(provider.id)) continue;
                const stored = await getProviderApiKey(provider.id);
                if (stored) {
                  backfill[provider.id] = stored;
                  // F1 修复：读到值即确认它在凭据库里。若不置位，下面这次 setState 会
                  // 经 persist 立即落盘，而 partialize 的例外分支会因此**保留明文**，
                  // 把刚清洗过的磁盘状态重新污染（独立审查 r1 实测复现的 critical 缺陷）。
                  markPersistedInKeyring(provider.id);
                }
              }
              const backfillIds = Object.keys(backfill);
              if (backfillIds.length > 0) {
                useSettingsStore.setState((current) => ({
                  settings: {
                    ...current.settings,
                    providers: current.settings.providers.map((p) =>
                      backfill[p.id] ? { ...p, apiKey: backfill[p.id]! } : p
                    ),
                  },
                }));
                console.log(
                  `[settingsStore] 已从系统凭据库回填 ${backfillIds.length} 个供应商密钥（仅内存，不落盘）`
                );
              }

              // F2 修复：迁移/回填成功后**主动**触发一次落盘清洗。
              //
              // 为什么必须：升级首次启动可能只走迁移 a（没有回填 setState），磁盘上的旧明文
              // 会一直留着，直到未来某次无关的 settings 写入（改主题、改节点映射）才被
              // partialize 顺手清洗 —— 验收第 3 条"迁移后再次保存不再含明文"就会变成
              // "无限期滞留"。这里在标志已置位的前提下立即写一次，让磁盘马上干净。
              // 只有当确实有清洗收益时才写（有明文在盘上，或刚做了迁移/回填）。
              const needsCleanWrite = plaintext.length > 0 || migratedIds.size > 0 || backfillIds.length > 0;
              if (needsCleanWrite) {
                useSettingsStore.getState().updateSettings({});
                console.log("[settingsStore] 已按凭据库状态重写本地配置（清除已迁移密钥的明文）");
              }
            })
            .catch((migrationError) => {
              console.warn("[settingsStore] 密钥迁移/回填失败，密钥按未配置处理:", migrationError);
            });
        };
      },
    }
  )
);
