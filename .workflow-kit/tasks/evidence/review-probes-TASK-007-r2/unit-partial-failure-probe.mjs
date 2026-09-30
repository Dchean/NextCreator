/**
 * r2 probe: partial keyring failure during migration (data-safety exception branch).
 * prov-c's set_provider_secret always fails; prov-d succeeds.
 * Expected (r1 finding F2 requirement): the FAILED item keeps its plaintext on disk
 * (data-safety exception), the SUCCEEDED item is cleared, and the clean write runs.
 */
import { registerHooks } from "node:module";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SRC = path.join(ROOT, "src");
const OUT = process.argv[2];
const FAKE_C = "FAKE-FAIL-CCCCCCCCCCCCCC";
const FAKE_D = "FAKE-OK-DDDDDDDDDDDDDDDD";

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const STUBS = {
  "@tauri-apps/plugin-store": `const doc = () => globalThis.__PROBE_DISK__;
    class Store { async get(k){ return doc()[k] ?? null; } async set(k, v){ doc()[k] = v; } async save(){} async delete(k){ delete doc()[k]; } }
    export const load = async () => new Store(); export default { load };`,
  "@tauri-apps/api/core": `export const invoke = async (cmd, args) => {
      const kr = globalThis.__PROBE_KEYRING__;
      if (cmd === "set_provider_secret") {
        if (args.providerId === "prov-c") throw new Error("写入凭据库失败: simulated <SANDBOX_WRITE_DENIED>");
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

globalThis.__PROBE_DISK__ = { "next-creator-settings": JSON.stringify({ state: { settings: { providers: [
  { id: "prov-c", name: "fails", apiKey: FAKE_C, baseUrl: "https://c.example.com", protocol: "google" },
  { id: "prov-d", name: "succeeds", apiKey: FAKE_D, baseUrl: "https://d.example.com", protocol: "google" },
], nodeProviders: {}, theme: "light" } }, version: 0 }) };
globalThis.__PROBE_KEYRING__ = {};

const { useSettingsStore } = await import("@/stores/settingsStore");
await new Promise((r) => setTimeout(r, 4500));

const diskRaw = globalThis.__PROBE_DISK__["next-creator-settings"] ?? "";
const disk = (JSON.parse(diskRaw).state.settings.providers || []).map((p) => ({ id: p.id, keyLen: (p.apiKey || "").length }));
const result = {
  diskProviders: disk,
  diskHasFailedKey: diskRaw.includes(FAKE_C),
  diskHasMigratedKey: diskRaw.includes(FAKE_D),
  keyring: Object.keys(globalThis.__PROBE_KEYRING__).map((k) => ({ id: k, len: globalThis.__PROBE_KEYRING__[k].length })),
};
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
