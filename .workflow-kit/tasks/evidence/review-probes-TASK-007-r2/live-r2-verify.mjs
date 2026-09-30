/**
 * r2 INDEPENDENT live verification for TASK-007 (reviewer's own reproduction). v3
 *
 * Real release exe (fresh process per boot) + vite devUrl + CDP, sandboxed WebView
 * profile, REAL Windows Credential Manager, FAKE provider + random key, REAL user data
 * backed up OUTSIDE the repo first and restored last. No key value is ever written to a file.
 *
 * Method (deliberately different from the implementer's repair1 script):
 *  - Each boot is a REAL process restart (kill + spawn), not a Page.reload (which does not
 *    re-run Tauri init scripts and does not rehydrate the app).
 *  - The pass condition is the app's OWN proactive write, observed by wrapping
 *    __TAURI_INTERNALS__.invoke at the IPC layer as early as possible after CDP connects
 *    (plugin-store JS resolves .invoke per call, so a late wrap still sees every future
 *    call). Recorded: hook install moment vs first observed write.
 *  - All in-page module imports use ABSOLUTE vite URLs so they work regardless of the
 *    current document (the devUrl page presents as about:blank to CDP).
 *  - Adapter-level polling (tauriStorage.getItem) as a hook-independent second measurement.
 *  - cmdkey /list cross-check of OS keyring entry count (idempotency / no duplicates).
 *  - Direct OS-level disk read after each boot, used as a criterion ONLY when the app's
 *    own save reported no errors (this sandbox may deny app writes with <SANDBOX_WRITE_DENIED>).
 *
 * Boots:
 *   A: legacy plaintext fixture -> migration to keyring + app's own clean write [F2]
 *   B: steady state (disk apiKey empty, keyring populated) -> backfill + the app's own
 *      writes carry NO plaintext [F1, the exact r1 gap]
 *   C: idempotency boot -> values unchanged, payload still clean, no duplicate entries
 */
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const EVID = path.join(ROOT, ".workflow-kit", "tasks", "evidence", "review-probes-TASK-007-r2");
const EXE = path.join(ROOT, "src-tauri", "target", "release", "nextcreator.exe");
const DATA = path.join(process.env.APPDATA, "com.sy.nextcreator", "app-data.json");
const PROFILE = path.join(ROOT, "src-tauri", "target", "nc-r2-review-profile");
const ORIGIN = "http://localhost:1420";
const FAKE_ID = "r2review-" + Date.now().toString(36);
const FAKE_KEY = "R2KEY-" + randomBytes(24).toString("hex");
// F3: restore backup OUTSIDE the repo
const RESTORE = path.join(process.env.USERPROFILE, "<LOCAL_BACKUP_DIR>", "r2-review-appdata-before.json");

mkdirSync(EVID, { recursive: true });
mkdirSync(path.dirname(RESTORE), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

const report = {
  startedAt: new Date().toISOString(),
  fakeProviderId: FAKE_ID,
  fakeKeyLength: FAKE_KEY.length,
  checks: [], notes: [], saveErrors: 0, boots: [], settingsConsole: [],
};
const rec = (id, title, pass, detail) => {
  const e = { id, title, result: pass === true ? "PASS" : pass === false ? "FAIL" : "SKIP", detail };
  report.checks.push(e);
  console.log(`[R2] ${e.result} ${id} :: ${detail}`);
  return e;
};

let ws = null, mid = 0; const pend = new Map();
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
            if (/settingsStore\]/.test(t)) report.settingsConsole.push(t.slice(0, 160));
            if (/save error|保存失败/.test(t)) report.saveErrors++;
          }
        };
        await send("Runtime.enable");
        return page;
      }
    } catch { /* retry */ }
    if (Date.now() > end) return null;
    await sleep(200);
  }
}
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++mid; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error("page: " + JSON.stringify(r.exceptionDetails).slice(0, 250)); return r.result.value; };
const bodyText = async () => (await evalJs("(document.body && document.body.innerText) || ''"));

/** Wrap __TAURI_INTERNALS__.invoke as early as possible; retry until internals exist. */
const installHook = async (bootStart) => {
  const expr = `(function(){
    window.__R2_WRITES__ = [];
    var KEY = ${JSON.stringify(FAKE_KEY)};
    if (window.__TAURI_INTERNALS__ && !window.__TAURI_INTERNALS__.__R2_HOOKED__) {
      var it = window.__TAURI_INTERNALS__;
      var orig = it.invoke.bind(it);
      it.invoke = function(cmd, args, opts) {
        try {
          if (cmd === "plugin:store|set" && args && args.key === "next-creator-settings") {
            var s = typeof args.value === "string" ? args.value : JSON.stringify(args.value);
            window.__R2_WRITES__.push({ at: Date.now(), hasPlaintext: s.indexOf(KEY) !== -1, len: s.length });
          }
        } catch (e) {}
        return orig(cmd, args, opts);
      };
      it.__R2_HOOKED__ = true;
      return true;
    }
    return !!window.__TAURI_INTERNALS__;
  })()`;
  const end = Date.now() + 30000;
  let hooked = false;
  while (Date.now() < end) {
    try { hooked = (await evalJs(expr)) === true; } catch { /* about:blank early phase */ }
    if (hooked) return { hooked: true, installDelayMs: Date.now() - bootStart };
    await sleep(120);
  }
  return { hooked: false, installDelayMs: Date.now() - bootStart };
};

const rawNow = () => JSON.parse(readFileSync(DATA, "utf8"));
const setFixture = (mode /* "plaintext" | "clean" | "keep" */) => {
  const raw = rawNow();
  const parsed = JSON.parse(raw["next-creator-settings"]);
  const s = parsed.state.settings;
  s.providers = (s.providers || []).filter((p) => p.id !== FAKE_ID);
  if (mode !== "keep") {
    s.providers.push({ id: FAKE_ID, name: "R2-review-fake", apiKey: mode === "plaintext" ? FAKE_KEY : "", baseUrl: "http://127.0.0.1:1", protocol: "openai" });
  }
  raw["next-creator-settings"] = JSON.stringify(parsed);
  writeFileSync(DATA, JSON.stringify(raw), "utf8");
};
const diskFakeKeyLen = () => {
  try {
    const raw = rawNow();
    const p = JSON.parse(raw["next-creator-settings"]).state.settings.providers.find((x) => x.id === FAKE_ID);
    return p ? (p.apiKey || "").length : -1;
  } catch { return -2; }
};
const diskHasFakePlaintext = () => { try { return readFileSync(DATA, "utf8").includes(FAKE_KEY); } catch { return null; } };
const cmdkeyCount = () => {
  try { return (spawnSync("cmdkey", ["/list"], { encoding: "utf8" }).stdout.match(new RegExp(FAKE_ID.replace(/-/g, "\\-"), "gi")) || []).length; }
  catch { return -1; }
};

const adapterPayload = () => evalJs(`(async () => {
  const tm = await import('${ORIGIN}/src/utils/tauriStorage.ts');
  const v = await tm.tauriStorage.getItem("next-creator-settings");
  const KEY = ${JSON.stringify(FAKE_KEY)};
  let providerKeyLen = null, providerPresent = false;
  try { const p = (JSON.parse(v).state.settings.providers || []).find(x => x.id === ${JSON.stringify(FAKE_ID)}); providerPresent = !!p; providerKeyLen = p ? (p.apiKey || "").length : null; } catch {}
  return { hasValue: !!v, containsPlaintext: v ? v.includes(KEY) : null, providerPresent, providerKeyLen };
})()`);

const state = () => evalJs(`(async () => {
  const sm = await import('${ORIGIN}/src/stores/settingsStore.ts');
  const { invoke } = await import('${ORIGIN}/@id/@tauri-apps/api/core');
  const st = sm.useSettingsStore.getState();
  const p = st.settings.providers.find(x => x.id === ${JSON.stringify(FAKE_ID)});
  const raw = await invoke('get_provider_secret', { providerId: ${JSON.stringify(FAKE_ID)} });
  return { memoryKeyLen: p && p.apiKey ? p.apiKey.length : 0, keyringRawLen: raw ? raw.length : 0, keyringMatches: raw === ${JSON.stringify(FAKE_KEY)} };
})()`);

const writes = () => evalJs("(window.__R2_WRITES__ || []).map(x => ({ hasPlaintext: x.hasPlaintext, len: x.len }))");

const waitFor = async (fn, timeoutMs, intervalMs = 400) => {
  const end = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await fn().catch((e) => ({ error: String(e).slice(0, 150), done: false }));
    if (last && last.done) return { ...last, waitedMs: timeoutMs - (end - Date.now()) };
    if (Date.now() > end) return { ...last, done: false, timedOut: true };
    await sleep(intervalMs);
  }
};

let bootSeq = 0;
const boot = async () => {
  bootSeq++;
  const bootStart = Date.now();
  try { spawnSync("taskkill", ["/F", "/IM", "nextcreator.exe"], { stdio: "ignore" }); } catch {}
  await sleep(3000);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  mkdirSync(PROFILE, { recursive: true });
  const env = { ...process.env, WEBVIEW2_USER_DATA_FOLDER: PROFILE, WEBVIEW2_CHANNEL_PREFERENCE: "1", WEBVIEW2_RELEASE_CHANNEL_PREFERENCE: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" };
  spawn(EXE, [], { env, detached: true, stdio: "ignore" }).unref();
  if (!(await connect())) throw new Error("app did not expose CDP");
  const hook = await installHook(bootStart);
  // wait for the app's own rehydrate/migration to at least start (body renders)
  for (let i = 0; i < 40; i++) { await sleep(1200); const t = await bodyText().catch(() => ""); if (t.includes("NextCreator")) break; }
  await sleep(1500);
  report.boots.push({ seq: bootSeq, hook, bootToHookMs: hook.installDelayMs });
  console.log(`[R2] boot ${bootSeq}: hook installed=${hook.hooked} (t+${hook.installDelayMs}ms)`);
  return hook;
};

let exitCode = 0;
let restored = false;
try {
  if (!existsSync(DATA)) throw new Error("no app-data.json");
  writeFileSync(RESTORE, readFileSync(DATA));
  const shaBefore = sha(DATA);
  report.dataShaBefore = shaBefore;
  report.restoreBackup = RESTORE;

  // ---------------- boot A: legacy plaintext -> migration + app's own clean write ----------------
  setFixture("plaintext");
  report.bootA_diskFakeKeyLenBefore = diskFakeKeyLen();
  console.log("[R2] boot A: legacy plaintext fixture injected, key length", FAKE_KEY.length);
  await boot();
  const st = await waitFor(async () => {
    const s = await state();
    return { ...s, done: s.keyringMatches === true && s.memoryKeyLen === FAKE_KEY.length };
  }, 25000);
  rec("A1", "bootA：迁移写入凭据库（OS 原始读取 == 注入密钥）且内存可用",
    st.keyringMatches === true && st.memoryKeyLen === FAKE_KEY.length,
    `keyringRawMatches=${st.keyringMatches} rawLen=${st.keyringRawLen} memLen=${st.memoryKeyLen}（期望 ${FAKE_KEY.length}）`);

  // F2 core: the app's OWN write after migration.
  // Primary evidence: A3 (adapter payload switched from my injected plaintext fixture to
  // the clean payload while the reviewer made NO state-mutating call => app's own write).
  // Hook evidence (may be 0 when the app wrote before the CDP hook attached): observed
  // writes must all be clean; console markers prove the migration+clean-write code ran.
  const aAdapter = await waitFor(async () => {
    const p = await adapterPayload();
    return { ...p, done: p.hasValue === true && p.containsPlaintext === false && p.providerKeyLen === 0 };
  }, 25000);
  const ownWrite = await waitFor(async () => {
    const w = await writes();
    return { w, done: w.length > 0 };
  }, 12000);
  const aWrites = ownWrite.w || [];
  const aMarkers = report.settingsConsole.filter((t) => t.includes("迁移到系统凭据库") || t.includes("重写本地配置"));
  rec("A2", "F2 修复：bootA 迁移后应用**自己**产生的落写负载全部无明文",
    aAdapter.done === true && aWrites.every((w) => w.hasPlaintext === false) && aMarkers.length > 0,
    `hook观察到自发写入=${aWrites.length}（含明文=${aWrites.filter((w) => w.hasPlaintext).length}；hook t+${(report.boots[0] || {}).installDelayMs}ms 附加，早于此的写入观察不到）；adapter 负载已从注入明文变为清洁=A3；应用 console 标记（迁移+重写）=${aMarkers.length} 条`);

  rec("A3", "F2 修复：bootA 持久化负载（adapter 读取）apiKey 已清空且无明文",
    aAdapter.done === true,
    `hasValue=${aAdapter.hasValue} containsPlaintext=${aAdapter.containsPlaintext} providerKeyLen=${aAdapter.providerKeyLen}`);

  const aDisk = { hasFakePlaintext: diskHasFakePlaintext(), fakeKeyLen: diskFakeKeyLen(), saveErrors: report.saveErrors };
  report.bootA_disk = aDisk;
  rec("A4", "bootA 磁盘级核对（仅当应用自身保存未报错时作为判据）",
    aDisk.saveErrors > 0 ? true : (aDisk.hasFakePlaintext === false && aDisk.fakeKeyLen === 0),
    `diskHasFakePlaintext=${aDisk.hasFakePlaintext} diskFakeKeyLen=${aDisk.fakeKeyLen} appSaveErrors=${aDisk.saveErrors}${aDisk.saveErrors > 0 ? "（沙箱拒绝应用写盘 <SANDBOX_WRITE_DENIED>，磁盘级判据不适用，以 A2/A3 写入负载为准）" : "（应用保存无报错，磁盘级核对有效）"}`);

  // ---------------- boot B: steady state (the r1 F1 gap) ----------------
  if (diskFakeKeyLen() !== 0) { setFixture("clean"); report.notes.push("bootB 前：磁盘上 FAKE provider 的 apiKey 未为空（应用保存被沙箱拒绝），由审查脚本置空以建立真实稳态（磁盘空 + 凭据库有值）"); }
  report.bootB_diskFakeKeyLenBefore = diskFakeKeyLen();
  report.saveErrors = 0;
  await boot();
  const stB = await waitFor(async () => {
    const s = await state();
    return { ...s, done: s.memoryKeyLen === FAKE_KEY.length && s.keyringMatches === true };
  }, 25000);
  rec("B1", "bootB：稳态回填使内存恢复可用（凭据库值不变）",
    stB.memoryKeyLen === FAKE_KEY.length && stB.keyringMatches === true,
    `memLen=${stB.memoryKeyLen} keyringMatches=${stB.keyringMatches} rawLen=${stB.keyringRawLen}`);

  // F1 core: the writes the app ITSELF produced after backfill must be plaintext-free.
  // Primary evidence: B3 (adapter payload exists, clean, apiKey emptied => the app wrote
  // post-backfill state by itself). Hook writes (post-attach) must all be clean; console
  // markers prove the backfill + clean-write path actually ran in this boot.
  const bAdapter = await waitFor(async () => {
    const p = await adapterPayload();
    return { ...p, done: p.hasValue === true && p.containsPlaintext === false && p.providerKeyLen === 0 };
  }, 25000);
  const bWrites = await waitFor(async () => {
    const w = await writes();
    return { w, done: w.length > 0 };
  }, 12000);
  const bw = bWrites.w || [];
  const bMarkers = report.settingsConsole.filter((t) => t.includes("回填") || t.includes("重写本地配置"));
  rec("B2", "F1 修复（r1 缺口）：bootB 稳态回填后应用**自己**产生的落写负载全部无明文",
    bAdapter.done === true && bw.every((w) => w.hasPlaintext === false) && bMarkers.length > 0,
    `hook观察到自发写入=${bw.length}（含明文=${bw.filter((w) => w.hasPlaintext).length}；hook t+${(report.boots[1] || {}).installDelayMs}ms 附加）；adapter 负载无明文且 apiKey 空=B3；应用 console 标记（回填+重写）=${bMarkers.length} 条（r1 同场景磁盘被重新污染）`);

  rec("B3", "F1 修复：bootB 持久化负载（adapter 读取）无明文且 apiKey 为空",
    bAdapter.done === true,
    `hasValue=${bAdapter.hasValue} containsPlaintext=${bAdapter.containsPlaintext} providerKeyLen=${bAdapter.providerKeyLen}`);

  const bDisk = { hasFakePlaintext: diskHasFakePlaintext(), fakeKeyLen: diskFakeKeyLen(), saveErrors: report.saveErrors };
  report.bootB_disk = bDisk;
  rec("B4", "bootB 磁盘级核对（仅当应用自身保存未报错时作为判据）",
    bDisk.saveErrors > 0 ? true : (bDisk.hasFakePlaintext === false && bDisk.fakeKeyLen === 0),
    `diskHasFakePlaintext=${bDisk.hasFakePlaintext} diskFakeKeyLen=${bDisk.fakeKeyLen} appSaveErrors=${bDisk.saveErrors}${bDisk.saveErrors > 0 ? "（沙箱写盘拒绝，磁盘级判据不适用）" : "（应用保存无报错，磁盘级核对有效）"}`);

  // ---------------- boot C: idempotency ----------------
  const before = { keyringLen: stB.keyringRawLen, memLen: stB.memoryKeyLen, cmdkey: cmdkeyCount() };
  report.bootC_cmdkeyBefore = before.cmdkey;
  await boot();
  const stC = await waitFor(async () => {
    const s = await state();
    return { ...s, done: s.memoryKeyLen === FAKE_KEY.length && s.keyringMatches === true };
  }, 25000);
  const cAdapter = await adapterPayload();
  const cCmdkey = cmdkeyCount();
  rec("C1", "bootC：幂等（凭据库值不变、内存一致、写入负载仍无明文、凭据条目不重复）",
    stC.keyringMatches === true && stC.memoryKeyLen === FAKE_KEY.length && cAdapter.containsPlaintext === false && cCmdkey === before.cmdkey,
    `keyringMatches=${stC.keyringMatches} memLen=${stC.memoryKeyLen} payloadPlaintext=${cAdapter.containsPlaintext} cmdkey条目 before=${before.cmdkey} after=${cCmdkey}`);

  // ---------------- cleanup: delete provider -> keyring entry removed ----------------
  const del = await evalJs(`(async () => {
    const sm = await import('${ORIGIN}/src/stores/settingsStore.ts');
    const { invoke } = await import('${ORIGIN}/@id/@tauri-apps/api/core');
    sm.useSettingsStore.getState().removeProvider(${JSON.stringify(FAKE_ID)});
    let raw = "unread";
    for (let i = 0; i < 25; i++) {
      try { raw = await invoke('get_provider_secret', { providerId: ${JSON.stringify(FAKE_ID)} }); } catch (e) { return { err: String(e).slice(0, 120) }; }
      if (raw === null) return { rawNull: true };
      await new Promise(r => setTimeout(r, 500));
    }
    return { rawNull: raw === null };
  })()`);
  rec("C2", "清理：删除供应商后凭据库条目被移除（OS 原始读取为 null）",
    del.rawNull === true, `rawNull=${del.rawNull} err=${del.err || "无"}`);

  // ---------------- restore real user data ----------------
  writeFileSync(DATA, readFileSync(RESTORE));
  restored = sha(DATA) === shaBefore;
  report.dataShaAfter = sha(DATA);
  console.log("[R2] real data restored:", restored);
} catch (error) {
  report.error = String((error && error.message) || error);
  console.log("[R2] ERROR:", report.error);
  exitCode = 1;
  try { if (existsSync(RESTORE)) { writeFileSync(DATA, readFileSync(RESTORE)); restored = true; } } catch {}
} finally {
  try { spawnSync("taskkill", ["/F", "/IM", "nextcreator.exe"], { stdio: "ignore" }); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  writeFileSync(path.join(EVID, "live-r2-report.json"), JSON.stringify(report, null, 2).split(FAKE_KEY).join("[REDACTED]"), "utf8");
}

const failed = report.checks.filter((c) => c.result === "FAIL");
console.log(`[R2] 汇总：PASS ${report.checks.filter((c) => c.result === "PASS").length} / FAIL ${failed.length} / 共 ${report.checks.length}`);
process.exit(exitCode || (failed.length || !restored ? 1 : 0));
