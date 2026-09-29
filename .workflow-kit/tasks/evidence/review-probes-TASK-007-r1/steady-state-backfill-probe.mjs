/**
 * 场景 D 探针：磁盘已清洁（apiKey=""）+ 凭据库有值 —— 模拟"成功保存后的下一次重启"。
 * 验证：内存回填（backfill setState）触发的 setItem 是否把明文重新写进磁盘负载。
 */
import { registerHooks } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SRC = path.join(ROOT, "src");
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "probe-state-d.json");

const FAKE_A = "FAKE-REVIEWER-KEY-AAAAAAAAAAAA";

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const STUBS = {
  "@tauri-apps/plugin-store": `const doc = () => globalThis.__PROBE_DISK__;
    class Store {
      async get(k){ return doc()[k] ?? null; }
      async set(k, v){ doc()[k] = v; globalThis.__PROBE_SETS__ = (globalThis.__PROBE_SETS__||0)+1; globalThis.__PROBE_SET_KEYS__ = (globalThis.__PROBE_SET_KEYS__||[]).concat(k); }
      async save(){ globalThis.__PROBE_SAVES__ = (globalThis.__PROBE_SAVES__||0)+1; }
      async delete(k){ delete doc()[k]; }
      async keys(){ return Object.keys(doc()); }
    }
    export const load = async () => new Store();
    export default { load };`,
  "@tauri-apps/api/core": `export const invoke = async (cmd, args) => {
      const kr = globalThis.__PROBE_KEYRING__;
      if (cmd === "set_provider_secret") { if (!args.secret) { delete kr[args.providerId]; return null; } kr[args.providerId] = args.secret; return null; }
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

// 场景 D 种子：磁盘清洁（apiKey 为空串）、凭据库已有值 —— 与实机上"用户保存成功后重启"的稳态一致
globalThis.__PROBE_DISK__ = {
  "next-creator-settings": JSON.stringify({
    state: {
      settings: {
        providers: [
          { id: "prov-a", name: "A(已迁移)", apiKey: "", baseUrl: "https://api.example.com", protocol: "google" },
        ],
        nodeProviders: {},
        theme: "light",
      },
    },
    version: 0,
  }),
};
globalThis.__PROBE_KEYRING__ = { "prov-a": FAKE_A };
globalThis.__PROBE_SETS__ = 0;
globalThis.__PROBE_SET_KEYS__ = [];
globalThis.__PROBE_SAVES__ = 0;

const { useSettingsStore } = await import("@/stores/settingsStore");
await new Promise((r) => setTimeout(r, 3500));

const mem = useSettingsStore.getState().settings.providers.map((p) => ({ id: p.id, memKeyLen: (p.apiKey || "").length }));
const diskRaw = globalThis.__PROBE_DISK__["next-creator-settings"] ?? "";
const diskProviders = diskRaw ? (JSON.parse(diskRaw).state?.settings?.providers || []).map((p) => ({ id: p.id, diskKeyLen: (p.apiKey || "").length })) : null;

const result = {
  scenario: "D: clean disk (apiKey='') + keyring populated (steady state after successful save + restart)",
  memory: mem,
  diskProviders,
  diskContainsPlaintext: diskRaw.includes(FAKE_A),
  diskKeyringKeyEcho: diskRaw.includes('"prov-a"'),
  pluginSetCalls: globalThis.__PROBE_SETS__,
  pluginSetKeys: globalThis.__PROBE_SET_KEYS__,
  pluginSaveCalls: globalThis.__PROBE_SAVES__,
};

writeFileSync(STATE_FILE, JSON.stringify({ finalDiskRaw: diskRaw ? JSON.parse(diskRaw) : null, plaintextOnDisk: diskRaw.includes(FAKE_A) }, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
