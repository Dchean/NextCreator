/**
 * r2 independent review probe: F1 (steady-state restart) + F2 (legacy upgrade first boot)
 * against the CURRENT candidate code (real settingsStore.ts / secretStore.ts, stubbed
 * plugin-store disk + stubbed OS keyring). No CDP, no real user data.
 *
 * usage: node unit-migration-backfill-probe.mjs D|A <outfile.json>
 *   D = F1 steady state: disk apiKey:"", keyring has value  (r1's critical scenario)
 *   A = F2 legacy upgrade: disk apiKey plaintext, keyring empty
 */
import { registerHooks } from "node:module";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SRC = path.join(ROOT, "src");
const SCEN = process.argv[2];
const OUT = process.argv[3];
const FAKE = "FAKE-REVIEWER-R2-" + SCEN + "-" + "X".repeat(9);

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const STUBS = {
  "@tauri-apps/plugin-store": `const doc = () => globalThis.__PROBE_DISK__;
    class Store {
      async get(k){ return doc()[k] ?? null; }
      async set(k, v){ doc()[k] = v; globalThis.__PROBE_SETS__++; }
      async save(){ globalThis.__PROBE_SAVES__++; }
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

if (SCEN === "D") {
  // F1 steady state: disk clean, keyring has value
  globalThis.__PROBE_DISK__ = { "next-creator-settings": JSON.stringify({ state: { settings: { providers: [{ id: "prov-a", name: "steady", apiKey: "", baseUrl: "https://api.example.com", protocol: "google" }], nodeProviders: {}, theme: "light" } }, version: 0 }) };
  globalThis.__PROBE_KEYRING__ = { "prov-a": FAKE };
} else {
  // F2 legacy upgrade: plaintext on disk, keyring empty
  globalThis.__PROBE_DISK__ = { "next-creator-settings": JSON.stringify({ state: { settings: { providers: [{ id: "prov-b", name: "legacy", apiKey: FAKE, baseUrl: "https://api.example.com", protocol: "google" }], nodeProviders: {}, theme: "light" } }, version: 0 }) };
  globalThis.__PROBE_KEYRING__ = {};
}
globalThis.__PROBE_SETS__ = 0;
globalThis.__PROBE_SAVES__ = 0;

const { useSettingsStore } = await import("@/stores/settingsStore");
await new Promise((r) => setTimeout(r, 4000));

const st = useSettingsStore.getState();
const mem = st.settings.providers.map((p) => ({ id: p.id, memKeyLen: (p.apiKey || "").length }));
const diskRaw = globalThis.__PROBE_DISK__["next-creator-settings"] ?? "";
const diskKeyLen = diskRaw ? (JSON.parse(diskRaw).state?.settings?.providers || []).map((p) => (p.apiKey || "").length) : [];
const result = {
  scenario: SCEN === "D" ? "F1 steady-state restart (disk apiKey empty, keyring populated)" : "F2 legacy upgrade first boot (disk plaintext, keyring empty)",
  memory: mem,
  diskProviderKeyLens: diskKeyLen,
  diskContainsPlaintext: diskRaw.includes(FAKE),
  pluginSetCalls: globalThis.__PROBE_SETS__,
  pluginSaveCalls: globalThis.__PROBE_SAVES__,
  keyringNow: Object.keys(globalThis.__PROBE_KEYRING__).map((k) => ({ id: k, len: globalThis.__PROBE_KEYRING__[k].length })),
};
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
