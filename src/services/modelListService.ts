import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "@/types";

// 远程模型信息
export interface RemoteModelInfo {
  id: string;
  label?: string;
}

interface ModelListEntry {
  models: RemoteModelInfo[];
  fetchedAt: number;
  loading: boolean;
  error?: string;
}

interface ModelListState {
  entries: Record<string, ModelListEntry>;
  // 拉取供应商的模型列表（带 TTL 缓存）
  fetchModels: (provider: Provider, force?: boolean) => Promise<void>;
  getCached: (providerId: string) => ModelListEntry | undefined;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

// 会话级内存缓存（不持久化：模型列表变化快，重新打开应用时重新拉取）
const entries: Record<string, ModelListEntry> = {};

export const useModelListStore = create<ModelListState>((set, get) => ({
  entries,

  fetchModels: async (provider, force = false) => {
    const cached = entries[provider.id];
    if (
      !force &&
      cached &&
      !cached.error &&
      Date.now() - cached.fetchedAt < CACHE_TTL_MS
    ) {
      return;
    }

    // 避免并发重复请求
    if (cached?.loading) return;

    set((state) => ({
      entries: {
        ...state.entries,
        [provider.id]: {
          models: cached?.models || [],
          fetchedAt: cached?.fetchedAt || 0,
          loading: true,
        },
      },
    }));

    try {
      const models = await invoke<RemoteModelInfo[]>("list_models", {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        protocol: provider.protocol,
      });

      set((state) => ({
        entries: {
          ...state.entries,
          [provider.id]: {
            models,
            fetchedAt: Date.now(),
            loading: false,
          },
        },
      }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((state) => ({
        entries: {
          ...state.entries,
          [provider.id]: {
            models: cached?.models || [],
            fetchedAt: cached?.fetchedAt || 0,
            loading: false,
            error: message,
          },
        },
      }));
    }
  },

  getCached: (providerId) => get().entries[providerId],
}));

// 解析远程模型的显示标签
export function getRemoteModelLabel(model: RemoteModelInfo): string {
  return model.label || model.id;
}
