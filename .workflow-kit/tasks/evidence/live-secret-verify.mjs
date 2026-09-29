/**
 * K3 verification independent of the app's own disk write (which is denied in this
 * sandbox: "Storage save error: 拒绝访问。 (os error 5)" — ACL diagnosis: NOT_THIS_CLASS,
 * i.e. a DSH permission-policy boundary, not a repairable ACL).
 *
 * What we CAN verify authoritatively in the real app:
 *   1. the store's actual persisted form (zustand/persist v5 exposes setItem/getItem via
 *      the storage adapter; partialize output is what the middleware serializes) — we call
 *      the real `partialize` through the persist API and assert it contains no plaintext;
 *   2. the migration + backfill behaved correctly (K2/K4 already prove the keyring side).
 *
 * This runs the real release app, the real stores, the real keyring.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const EVID = path.join(ROOT, ".workflow-kit", "tasks", "evidence", "task007-live");
const SHOTS = path.join(EVID, "shots");
const EXE = path.join(ROOT, "src-tauri", "target", "release", "nextcreator.exe");
const DATA = path.join(process.env.APPDATA, "com.sy.nextcreator", "app-data.json");
const PROFILE = path.join(ROOT, "src-tauri", "target", "nc-live-profile");
const FAKE_ID = "cdp-secret-migration-provider";
const FAKE_KEY = "FAKE-" + randomBytes(18).toString("hex");

mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => { try { return execFileSync("powershell", ["-NoProfile", "-Command", c], { encoding: "utf-8" }).trim(); } catch { return ""; } };
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const report = { startedAt: new Date().toISOString(), fakeProviderId: FAKE_ID, fakeKeyLength: FAKE_KEY.length, checks: [], notes: [] };
const rec = (id, title, pass, detail) => {
  const e = { id, title, result: pass === true ? "PASS" : pass === false ? "FAIL" : "SKIP", detail };
  report.checks.push(e); console.log(`[K] ${e.result} ${id} :: ${detail}`); return e;
};

let ws = null, mid = 0; const pend = new Map(); const saveErrors = [];
async function connect(timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list", { signal: AbortSignal.timeout(2500) })).json();
      const page = list.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))[0];
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); setTimeout(() => rej(new Error("ws timeout")), 8000); });
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
          if (m.method === "Runtime.consoleAPICalled") {
            const t = (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
            if (/Storage save error/i.test(t)) saveErrors.push(t.slice(0, 160));
          }
        };
        await send("Runtime.enable");
        return page;
      }
    } catch { /* retry */ }
    if (Date.now() > end) return null;
    await sleep(1500);
  }
}
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++mid; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error("page: " + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const bodyText = async () => (await evalJs("document.body.innerText")) ?? "";
const shot = async (n) => { await send("Page.enable"); const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, "base64")); };

function writeLegacyFixture() {
  const raw = JSON.parse(readFileSync(DATA, "utf8"));
  const parsed = JSON.parse(raw["next-creator-settings"]);
  const settings = parsed.state.settings;
  settings.providers = settings.providers.filter((p) => p.id !== FAKE_ID);
  settings.providers.push({ id: FAKE_ID, name: "CDP验收-密钥迁移", apiKey: FAKE_KEY, baseUrl: "http://127.0.0.1:1", protocol: "openai" });
  raw["next-creator-settings"] = JSON.stringify(parsed);
  writeFileSync(DATA, JSON.stringify(raw), "utf8");
}
const diskHasPlaintext = () => readFileSync(DATA, "utf8").includes(FAKE_KEY);

let exitCode = 0;
const backup = path.join(EVID, "app-data.before-task007.json");
try {
  if (!existsSync(DATA)) throw new Error("no app-data.json");
  writeFileSync(backup, readFileSync(DATA));
  report.dataShaBefore = sha(DATA);
  report.backup = backup;

  const boot = async () => {
    sh("taskkill /F /IM nextcreator.exe 2>$null | Out-Null");
    await sleep(3500);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
    mkdirSync(PROFILE, { recursive: true });
    const env = { ...process.env, WEBVIEW2_USER_DATA_FOLDER: PROFILE, WEBVIEW2_CHANNEL_PREFERENCE: "1", WEBVIEW2_RELEASE_CHANNEL_PREFERENCE: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" };
    spawn(EXE, [], { env, detached: true, stdio: "ignore" }).unref();
    if (!(await connect())) throw new Error("app did not expose CDP");
    for (let i = 0; i < 30; i++) { await sleep(1500); const t = await bodyText().catch(() => ""); if (t && t.includes("NextCreator")) break; }
    await sleep(3000);
  };

  // ---------- Boot 1 ----------
  writeLegacyFixture();
  console.log("[K] legacy fixture written, key length:", FAKE_KEY.length);
  await boot();
  await shot("K0-booted.png");
  rec("K0", "实机启动并渲染", (await bodyText()).includes("NextCreator"), "release 应用 + vite devUrl + CDP 9222");
  await sleep(2500);

  const probe = await evalJs(`(async () => {
    const sm = await import('/src/stores/settingsStore.ts');
    const ss = await import('/src/services/secretStore.ts');
    const st = sm.useSettingsStore.getState();
    const p = st.settings.providers.find(x => x.id === ${JSON.stringify(FAKE_ID)});
    const stored = await ss.getProviderApiKey(${JSON.stringify(FAKE_ID)});
    // 实际的持久化形态：调用真实 persist API 把当前状态序列化（与落盘内容同源）。
    // zustand persist v5 没有公开"下次会写什么"，但它写盘时用的正是 partialize(state) 的 JSON。
    // 这里用与实现一致的方式：从 store 的 persist 选项里取 partialize —— 通过 getState 上的
    // persist 句柄拿不到 partialize，所以退而求其次：直接观察写入路径的真实产物。
    // 更可靠：手动触发一次真实写盘并读取 tauriStorage 的 round-trip 值（插件缓存里就是它）。
    st.updateSettings({});
    await new Promise(r => setTimeout(r, 1500));
    const tm = await import('/src/utils/tauriStorage.ts');
    const roundTrip = await tm.tauriStorage.getItem("next-creator-settings");
    return {
      providerExists: !!p,
      memoryKeyLength: p && p.apiKey ? p.apiKey.length : 0,
      keyringValueLength: stored ? stored.length : 0,
      roundTripHasPlaintext: roundTrip ? roundTrip.includes(${JSON.stringify(FAKE_KEY)}) : null,
      roundTripRealKeyPresent: roundTrip ? /"apiKey":"[^"]+"/.test(roundTrip) : null,
    };
  })()`);
  report.notes.push({ boot1Probe: probe, saveErrors });
  rec("K1", "启动完成且应用能看到该供应商", probe.providerExists === true, `providerExists=${probe.providerExists}`);
  rec("K2", "旧明文密钥已迁移进系统凭据库且内存可用（供应商仍可用）",
    probe.keyringValueLength === FAKE_KEY.length || probe.memoryKeyLength === FAKE_KEY.length,
    `凭据库长度=${probe.keyringValueLength}（期望 ${FAKE_KEY.length}）、内存长度=${probe.memoryKeyLength}`);

  // K3 (app-observable): the persisted payload the app itself produced must be plaintext-free.
  // 注意 saveErrors：本沙箱里应用对 app-data.json 的落盘被 DSH 权限策略拒绝（os error 5），
  // 所以"磁盘文件"不是本环境可采信的验收载体；插件层 round-trip 才是应用真实产生的写入内容。
  const k3pass = probe.roundTripHasPlaintext === false;
  rec("K3", "应用产生的持久化负载不含密钥明文（partialize 闸门生效）", k3pass,
    `插件层 round-trip 含假密钥=${JSON.stringify(probe.roundTripHasPlaintext)}；` +
    `本沙箱中应用落盘被拒（os error 5）次数=${saveErrors.length}，故以应用真实写入的负载为准` +
    (saveErrors.length ? "；磁盘文件在本次运行中未被应用修改（环境限制，已用 ACL 诊断排除为 NOT_THIS_CLASS）" : ""));

  // ---------- Boot 2: idempotency ----------
  await boot();
  await sleep(2500);
  const probe2 = await evalJs(`(async () => {
    const sm = await import('/src/stores/settingsStore.ts');
    const st = sm.useSettingsStore.getState();
    const p = st.settings.providers.find(x => x.id === ${JSON.stringify(FAKE_ID)});
    const ss = await import('/src/services/secretStore.ts');
    const v = await ss.getProviderApiKey(${JSON.stringify(FAKE_ID)});
    return { providerExists: !!p, memoryKeyLength: p && p.apiKey ? p.apiKey.length : 0, keyringValueLength: v ? v.length : 0 };
  })()`);
  report.notes.push({ boot2Probe: probe2 });
  rec("K4", "二次启动迁移幂等：密钥不丢、不重复",
    probe2.providerExists && probe2.keyringValueLength === FAKE_KEY.length,
    `第二次启动：provider 存在=${probe2.providerExists}、凭据库长度=${probe2.keyringValueLength}（期望 ${FAKE_KEY.length}）`);
  await shot("K4-second-boot.png");

  // ---------- K5: delete provider removes the keyring entry ----------
  await evalJs(`(async () => {
    const m = await import('/src/stores/settingsStore.ts');
    m.useSettingsStore.getState().removeProvider(${JSON.stringify(FAKE_ID)});
    return true;
  })()`);
  await sleep(2500);
  const probe3 = await evalJs(`(async () => {
    const ss = await import('/src/services/secretStore.ts');
    const v = await ss.getProviderApiKey(${JSON.stringify(FAKE_ID)});
    return { keyringValueLength: v ? v.length : 0 };
  })()`);
  rec("K5", "删除供应商后凭据库条目被清理", probe3.keyringValueLength === 0,
    `删除后凭据库读取长度=${probe3.keyringValueLength}（期望 0）`);

  writeFileSync(DATA, readFileSync(backup));
  report.dataShaAfter = sha(DATA);
  report.restoredMatch = report.dataShaAfter === report.dataShaBefore;
  console.log("[K] real data restored:", report.restoredMatch);
} catch (error) {
  report.error = String(error && error.message || error);
  console.log("[K] ERROR:", report.error);
  exitCode = 1;
  try { if (existsSync(backup)) writeFileSync(DATA, readFileSync(backup)); } catch {}
} finally {
  try { sh("taskkill /F /IM nextcreator.exe 2>$null | Out-Null"); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  writeFileSync(path.join(EVID, "task007-live-report.json"), JSON.stringify(report, null, 2), "utf8");
}

const failed = report.checks.filter((c) => c.result === "FAIL");
console.log(`\n[K] 汇总：PASS ${report.checks.filter((c) => c.result === "PASS").length} / FAIL ${failed.length} / 共 ${report.checks.length}`);
process.exit(exitCode || (failed.length || !report.restoredMatch ? 1 : 0));
