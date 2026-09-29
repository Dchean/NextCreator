/** Isolated check: does invoke('delete_provider_secret') actually remove the entry? */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const EVID = path.join(ROOT, ".workflow-kit", "tasks", "evidence", "task007-live");
const EXE = path.join(ROOT, "src-tauri", "target", "release", "nextcreator.exe");
const DATA = path.join(process.env.APPDATA, "com.sy.nextcreator", "app-data.json");
const PROFILE = path.join(ROOT, "src-tauri", "target", "nc-live-profile");
const ID = "cdp-delete-probe-" + Date.now().toString(36);
const KEY = "DEL-" + randomBytes(9).toString("hex");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => { try { return execFileSync("powershell", ["-NoProfile", "-Command", c], { encoding: "utf-8" }).trim(); } catch { return ""; } };
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
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
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
        await send("Runtime.enable");
        return page;
      }
    } catch {}
    if (Date.now() > end) return null;
    await sleep(1500);
  }
}
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++mid; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error("page: " + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };

const RESTORE = path.join(process.env.USERPROFILE, "NextCreator-key-backups", "task007-delprobe-before.json");
try {
  writeFileSync(RESTORE, readFileSync(DATA));
  const before = sha(DATA);
  await boot();
  const r = await evalJs(`(async () => {
    const ss = await import('/src/services/secretStore.ts');
    await ss.setProviderApiKey(${JSON.stringify(ID)}, ${JSON.stringify(KEY)});
    const afterSet = await ss.getProviderApiKey(${JSON.stringify(ID)});
    await ss.deleteProviderApiKey(${JSON.stringify(ID)});
    // 不绕过缓存：getProviderApiKey 会命中 knownMissing。为了验证"凭据库里真的没了"，
    // 直接走 invoke 读取（绕过前端缓存），这才是操作系统的真实状态。
    const { invoke } = await import('/@id/@tauri-apps/api/core');
    let raw = null, err = null;
    try { raw = await invoke('get_provider_secret', { providerId: ${JSON.stringify(ID)} }); } catch (e) { err = String(e); }
    return { afterSetLen: afterSet ? afterSet.length : 0, rawNull: raw === null, rawLen: raw ? raw.length : 0, err };
  })()`);
  console.log("delete-probe:", JSON.stringify(r));
  console.log("expected rawLen = 0 and rawNull = true if deletion truly removes the entry");
} catch (e) {
  console.log("ERROR:", e.message);
} finally {
  try { sh("taskkill /F /IM nextcreator.exe 2>$null | Out-Null"); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  try { writeFileSync(DATA, readFileSync(RESTORE)); console.log("restored:", sha(DATA) === before); } catch {}
}

async function boot() {
  sh("taskkill /F /IM nextcreator.exe 2>$null | Out-Null");
  await sleep(3500);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  mkdirSync(PROFILE, { recursive: true });
  const env = { ...process.env, WEBVIEW2_USER_DATA_FOLDER: PROFILE, WEBVIEW2_CHANNEL_PREFERENCE: "1", WEBVIEW2_RELEASE_CHANNEL_PREFERENCE: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" };
  spawn(EXE, [], { env, detached: true, stdio: "ignore" }).unref();
  if (!(await connect())) throw new Error("no CDP");
  for (let i = 0; i < 30; i++) { await sleep(1500); const t = await evalJs("document.body.innerText").catch(() => ""); if (t && t.includes("NextCreator")) break; }
  await sleep(2500);
}
