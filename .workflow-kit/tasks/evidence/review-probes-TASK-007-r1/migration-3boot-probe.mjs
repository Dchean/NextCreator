/**
 * 独立审查探针：TASK-007 迁移行为 3 次启动模拟（reviewer 编写，未复用实现者代码）。
 *
 * 模拟层：
 *   - keyring：内存 Map（providerId → secret），由 @tauri-apps/api/core 的 invoke 桩实现。
 *   - app-data.json：内存 Map（storageKey → JSON 字符串），由 @tauri-apps/plugin-store 桩实现；
 *     set() 更新内存文档，save() 模拟落盘（真实插件为防抖后整文件写回）。
 *   - 两次启动之间用 state 文件传递 disk + keyring（等价于重启进程）。
 *
 * 用法：node migration-3boot-probe.mjs --boot 1|2|3 [--action]
 *   --action：在启动稳定后触发一次 settingsStore 状态变更（模拟用户操作触发的持久化）。
 */
import { registerHooks } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SRC = path.join(ROOT, "src");
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "probe-state.json");

// ---- 进程参数 ----
const args = process.argv.slice(2);
const bootNo = Number(args[args.indexOf("--boot") + 1]);
const withAction = args.includes("--action");

// ---- 跨启动状态（disk + keyring）----
let state = { disk: {}, keyring: {}, log: [] };
if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, "utf8"));

const FAKE_A = "FAKE-REVIEWER-KEY-AAAAAAAAAAAA";
const FAKE_B = "FAKE-REVIEWER-KEY-BBBBBBBBBBBB";

// ---- 运行时 stub（先于任何业务 import）----
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const STUBS = {
  "@tauri-apps/plugin-store": `const doc = () => globalThis.__PROBE_DISK__;
    class Store {
      async get(k){ const v = doc()[k] ?? null; return v; }
      async set(k, v){ doc()[k] = v; globalThis.__PROBE_SETS__ = (globalThis.__PROBE_SETS__||0)+1; }
      async save(){ globalThis.__PROBE_SAVES__ = (globalThis.__PROBE_SAVES__||0)+1; }
      async delete(k){ delete doc()[k]; }
      async keys(){ return Object.keys(doc()); }
    }
    export const load = async () => new Store();
    export default { load };`,
  "@tauri-apps/api/core": `export const invoke = async (cmd, args) => {
      const kr = globalThis.__PROBE_KEYRING__;
      if (cmd === "set_provider_secret") {
        if (!args.secret) { delete kr[args.providerId]; return null; }
        kr[args.providerId] = args.secret; return null;
      }
      if (cmd === "get_provider_secret") { return kr[args.providerId] ?? null; }
      if (cmd === "delete_provider_secret") { delete kr[args.providerId]; return null; }
      throw new Error("stub invoke: unknown cmd " + cmd);
    };
    export const Channel = class {}; export const convertFileSrc = (p) => p; export default {};`,
};

registerHooks({
  resolve(spec, context, nextResolve) {
    if (STUBS[spec]) return { url: "stub:" + spec, shortCircuit: true };
    if (spec.startsWith("@/")) {
      const base = path.join(SRC, spec.slice(2));
      for (const c of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
        if (existsSync(c)) return { url: pathToFileURL(c).href, shortCircuit: true };
      }
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    return nextLoad(url, context);
  },
});

// ---- 组装本次启动的"机器状态" ----
if (bootNo === 1) {
  state = {
    disk: {
      // 模拟升级前的旧版 app-data.json（next-creator-settings 含明文密钥）：
      // provider A：protocol 已有、baseUrl 无版本后缀（旧迁移条件不会触发——实现者所称的 key trap 场景）
      // provider B：无 protocol、baseUrl 带 /v1beta（旧迁移条件会触发——对照组）
      "next-creator-settings": JSON.stringify({
        state: {
          settings: {
            providers: [
              { id: "prov-a", name: "A(无protocol变化)", apiKey: FAKE_A, baseUrl: "https://api.example.com", protocol: "google" },
              { id: "prov-b", name: "B(带v1beta后缀)", apiKey: FAKE_B, baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
            ],
            nodeProviders: {},
            theme: "light",
          },
        },
        version: 0,
      }),
    },
    keyring: {},
    log: [],
  };
}
globalThis.__PROBE_DISK__ = state.disk;
globalThis.__PROBE_KEYRING__ = state.keyring;
globalThis.__PROBE_SETS__ = 0;
globalThis.__PROBE_SAVES__ = 0;

// ---- 启动：首次 import settingsStore 触发真实水合 + 迁移 ----
const { useSettingsStore } = await import("@/stores/settingsStore");
await new Promise((r) => setTimeout(r, 3500)); // 等 动态import + IPC + 500ms 防抖落盘 全部稳定

const mem = useSettingsStore.getState().settings.providers.map((p) => ({
  id: p.id,
  memKeyLen: (p.apiKey || "").length,
}));
const diskRaw = state.disk["next-creator-settings"] ?? null;
let diskProviders = null;
let diskPlaintextHits = [];
if (diskRaw) {
  const parsed = JSON.parse(diskRaw);
  diskProviders = (parsed.state?.settings?.providers || []).map((p) => ({
    id: p.id,
    diskKeyLen: (p.apiKey || "").length,
  }));
  for (const k of [FAKE_A, FAKE_B]) {
    if (diskRaw.includes(k)) diskPlaintextHits.push(k.slice(0, 12) + "…");
  }
}
const keyringLens = Object.fromEntries(Object.entries(state.keyring).map(([k, v]) => [k, v.length]));

const result = {
  boot: bootNo,
  withAction,
  memory: mem,
  diskProviders,
  diskPlaintextHits,
  keyringLens,
  pluginSetCalls: globalThis.__PROBE_SETS__,
  pluginSaveCalls: globalThis.__PROBE_SAVES__,
};

// ---- 可选：模拟用户操作，强制一次 setItem（观察磁盘是否被清洗）----
if (withAction) {
  useSettingsStore.getState().setNodeProvider("llmContent", "prov-a");
  await new Promise((r) => setTimeout(r, 1500)); // 等 500ms 防抖落盘
  const diskRaw2 = state.disk["next-creator-settings"] ?? "";
  result.afterAction = {
    diskPlaintextHits: [FAKE_A, FAKE_B].filter((k) => diskRaw2.includes(k)).map((k) => k.slice(0, 12) + "…"),
    diskKeyLens: (JSON.parse(diskRaw2).state?.settings?.providers || []).map((p) => ({ id: p.id, len: (p.apiKey || "").length })),
  };
}

// ---- 快照"机器状态"供下一次 boot 使用（等价于进程重启）----
state.disk = globalThis.__PROBE_DISK__;
state.keyring = globalThis.__PROBE_KEYRING__;
state.log.push(result);
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
