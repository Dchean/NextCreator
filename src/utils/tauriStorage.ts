/**
 * Tauri Store 存储适配器
 * 用于 Zustand persist 中间件，使用 tauri-plugin-store
 */

// Store 实例缓存
let storeInstance: Awaited<ReturnType<typeof import("@tauri-apps/plugin-store").load>> | null = null;
// Store 初始化 Promise，避免重复初始化
let storeInitPromise: Promise<Awaited<ReturnType<typeof import("@tauri-apps/plugin-store").load>> | null> | null = null;
// 存储初始化失败提示只弹一次（每个会话）
let warnedStorageFailure = false;

// 获取或创建 Store 实例
async function getStore() {
  // 如果正在初始化中，等待完成
  if (storeInitPromise) {
    return storeInitPromise;
  }

  // 如果已经初始化完成，直接返回
  if (storeInstance) {
    return storeInstance;
  }

  // 开始初始化
  storeInitPromise = (async () => {
    try {
      const { load } = await import("@tauri-apps/plugin-store");
      storeInstance = await load("app-data.json", { autoSave: false, defaults: {} });
      return storeInstance;
    } catch (error) {
      console.error("Failed to initialize Tauri store:", error);
      storeInitPromise = null;
      if (!warnedStorageFailure) {
        warnedStorageFailure = true;
        const { useToastStore } = await import("@/stores/toastStore");
        useToastStore
          .getState()
          .warning("本地数据存储初始化失败，本次更改可能无法保存，请检查存储目录是否可用");
      }
      return null;
    }
  })();

  return storeInitPromise;
}

// 获取数据
async function getItem(key: string): Promise<string | null> {
  try {
    const store = await getStore();
    if (store) {
      const value = await store.get<string>(key);
      return value ?? null;
    }
    return null;
  } catch (error) {
    console.error("Storage getItem error:", error);
    return null;
  }
}

// save 防抖：合并高频写入，避免频繁磁盘 I/O
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savePending = false;

function debouncedSave(store: NonNullable<Awaited<ReturnType<typeof getStore>>>) {
  savePending = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (savePending) {
      savePending = false;
      try {
        await store.save();
      } catch (error) {
        console.error("Storage save error:", error);
      }
    }
  }, 500);
}

// 立即刷盘：清除防抖计时器并同步写入磁盘
// 用于应用关闭前确保数据不丢失
async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (savePending && storeInstance) {
    savePending = false;
    try {
      await storeInstance.save();
    } catch (error) {
      console.error("Storage flush save error:", error);
    }
  }
}

// 应用关闭前立即刷盘，防止防抖导致数据丢失
window.addEventListener("beforeunload", () => {
  flushSave();
});

// 设置数据
async function setItem(key: string, value: string): Promise<void> {
  try {
    const store = await getStore();
    if (store) {
      await store.set(key, value);
      // 防抖写入磁盘，500ms 内多次 set 只触发一次 save
      debouncedSave(store);
    }
  } catch (error) {
    console.error("Storage setItem error:", error);
  }
}

// 删除数据
async function removeItem(key: string): Promise<void> {
  try {
    const store = await getStore();
    if (store) {
      await store.delete(key);
      await store.save();
    }
  } catch (error) {
    console.error("Storage removeItem error:", error);
  }
}

// 导出符合 Zustand StateStorage 接口的对象
export const tauriStorage = {
  getItem,
  setItem,
  removeItem,
};

// 导出 flushSave 供外部在关键时机（如画布切换前）调用
export { flushSave };
