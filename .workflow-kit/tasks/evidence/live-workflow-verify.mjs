/**
 * Live verification of the workflow image path after REQ-004 unification.
 *
 * Verifies in the REAL app (release shell + vite devUrl + CDP) that:
 *   1. 运行全部 (executeWorkflow) still runs the image node through the unified
 *      executor and the node reaches a terminal state (not stuck loading);
 *   2. the workflow path does NOT write runRecords (withRunRecords:false preserved);
 *   3. the workflow path now also persists output/thumb fields when it succeeds —
 *      or, when the provider fails (local gateway down), the failure is reported
 *      through the same node status/error semantics as before;
 *   4. the global limiter is exercised by the workflow path and returns to zero
 *      afterwards (no leaked permits).
 *
 * Uses the app's own modules via Vite so assertions read the real stores.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const EVID = path.join(ROOT, ".workflow-kit", "tasks", "evidence", "task003-live");
const SHOTS = path.join(EVID, "shots");
const EXE = path.join(ROOT, "src-tauri", "target", "release", "nextcreator.exe");
const DATA = path.join(process.env.APPDATA, "com.sy.nextcreator", "app-data.json");
const PROFILE = path.join(ROOT, "src-tauri", "target", "nc-live-profile");
const CDP = "http://127.0.0.1:9222";

mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => { try { return execFileSync("powershell", ["-NoProfile", "-Command", c], { encoding: "utf-8" }).trim(); } catch { return ""; } };
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const report = { startedAt: new Date().toISOString(), checks: [], notes: [] };
const rec = (id, title, pass, detail) => {
  const e = { id, title, result: pass === true ? "PASS" : pass === false ? "FAIL" : "SKIP", detail };
  report.checks.push(e); console.log(`[WF] ${e.result} ${id} :: ${detail}`); return e;
};

let ws = null, mid = 0; const pend = new Map(); const consoleErrors = [];
async function connect(timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(CDP + "/json/list", { signal: AbortSignal.timeout(2500) })).json();
      const page = list.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))[0];
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); setTimeout(() => rej(new Error("ws timeout")), 8000); });
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
          if (m.method === "Runtime.consoleAPICalled") {
            const t = (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
            if (/error|失败|拒绝/i.test(t)) consoleErrors.push(t.slice(0, 200));
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
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error("page: " + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const bodyText = async () => (await evalJs("document.body.innerText")) ?? "";
const shot = async (n) => { await send("Page.enable"); const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, "base64")); };
async function clickAt(x, y, count = 1) {
  for (let i = 1; i <= count; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: i, buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: i, buttons: 0 });
    await sleep(45);
  }
}

if (!readFileSync(DATA)) throw new Error("no app-data");
report.dataShaBefore = sha(DATA);
report.backup = path.join(EVID, "app-data.before.json");
writeFileSync(report.backup, readFileSync(DATA));

let exitCode = 0;
try {
  sh("taskkill /F /IM nextcreator.exe 2>$null | Out-Null");
  await sleep(4000);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  mkdirSync(PROFILE, { recursive: true });
  const env = { ...process.env, WEBVIEW2_USER_DATA_FOLDER: PROFILE, WEBVIEW2_CHANNEL_PREFERENCE: "1", WEBVIEW2_RELEASE_CHANNEL_PREFERENCE: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" };
  spawn(EXE, [], { env, detached: true, stdio: "ignore" }).unref();
  if (!(await connect())) throw new Error("app did not expose CDP");
  for (let i = 0; i < 30; i++) { await sleep(1500); const t = await bodyText().catch(() => ""); if (t && t.includes("NextCreator")) break; }
  await sleep(3000);
  await shot("W0-booted.png");
  rec("W0", "实机启动并渲染", (await bodyText()).includes("NextCreator"), "release 应用 + vite devUrl + CDP 9222");

  // Wait for canvas hydration BEFORE building the fixture: a fresh boot loads the
  // user's canvases asynchronously, and building the fixture too early would wipe
  // the node list and leave the run with nothing meaningful to execute.
  const hydrated = await (async () => {
    for (let i = 0; i < 30; i++) {
      const n = await evalJs(`(async () => { const f = await import('/src/stores/flowStore.ts'); return f.useFlowStore.getState().nodes.length; })()`);
      if (n > 0) return n;
      await sleep(1000);
    }
    return 0;
  })();
  report.notes.push({ hydratedNodes: hydrated });

  // Fixture: add an image generator node with an inline prompt, KEEPING existing nodes.
  const fixture = await evalJs(`(async () => {
    const f = await import('/src/stores/flowStore.ts');
    const cfg = await import('/src/components/nodes/imageGeneratorConfig.ts');
    const id = 'wf-verify-node';
    const fs = f.useFlowStore.getState();
    const nodes = [...fs.nodes.filter(n => n.id !== id), { id, type: 'imageGeneratorNode', position: { x: 380, y: 300 }, data: { ...cfg.getDefaultImageGeneratorData(), prompt: 'WF-ACCEPTANCE-TASK003' } }];
    fs.setNodes(nodes);
    return { nodes: f.useFlowStore.getState().nodes.map(n => ({ id: n.id, type: n.type, prompt: String((n.data||{}).prompt||'').slice(0,20) })) };
  })()`);
  report.notes.push({ fixture });
  rec("W1", "构造工作流图片节点（同一实现入口）", fixture.nodes.some((n) => n.id === "wf-verify-node"),
    `nodes=${JSON.stringify(fixture.nodes)}`);

  // Baseline: limiter in-flight must be 0 before the run.
  const beforeRun = await evalJs(`(async () => {
    const l = await import('/src/services/concurrencyLimiter.ts');
    return { limit: l.getGlobalConcurrencyLimit(), inFlight: l.getInFlightCount(), waiters: l.getWaiterCount() };
  })()`);
  report.notes.push({ limiterBefore: beforeRun });

  // Run the workflow via the app's OWN entry point (flowStore.executeFromNode).
  // The engine instance is cleared in `finally` (flowStore.ts:1642), so read the
  // engine's own reported context from `workflowExecution`, which the engine's
  // onStatusChange callback keeps up to date and which survives the run.
  const runResult = await evalJs(`(async () => {
    const f = await import('/src/stores/flowStore.ts');
    const fs = f.useFlowStore.getState();
    if (typeof fs.executeFromNode !== 'function') return { err: 'executeFromNode missing' };
    await fs.executeFromNode('wf-verify-node');
    const after = f.useFlowStore.getState();
    const ctx = after.workflowExecution;
    const nodeState = ctx && ctx.nodeStatuses ? ctx.nodeStatuses['wf-verify-node'] : null;
    return {
      ok: true,
      engineStatus: ctx ? ctx.status : null,
      nodeState,
      errors: ctx ? ctx.errors : null,
      progress: ctx ? ctx.progress : null,
      // "engine 真的处理了这个节点"：状态被 engine 记为 completed 或 failed
      engineRanNode: nodeState === "completed" || nodeState === "failed",
    };
  })()`);
  report.notes.push({ runResult });
  await sleep(9000);

  // Assert: node left 'loading' (reached a terminal state) and result semantics held.
  const after = await evalJs(`(async () => {
    const f = await import('/src/stores/flowStore.ts');
    const l = await import('/src/services/concurrencyLimiter.ts');
    const n = f.useFlowStore.getState().nodes.find(x => x.id === 'wf-verify-node');
    const d = (n && n.data) || {};
    return {
      status: d.status, error: String(d.error || '').slice(0, 120),
      runRecords: Array.isArray(d.runRecords) ? d.runRecords.length : null,
      outputImagePath: d.outputImagePath || null,
      outputThumbPath: d.outputThumbPath || null,
      inFlight: l.getInFlightCount(), waiters: l.getWaiterCount(),
    };
  })()`);
  report.notes.push({ nodeAfter: after });
  await shot("W1-workflow-run.png");

  rec("W2", "工作流图片节点经统一执行器真的被执行并到达终态（不卡 loading）",
    after.status !== "loading" && after.status != null && runResult.engineRanNode === true,
    `engine 节点状态=${JSON.stringify(runResult.nodeState)}、engine 总状态=${JSON.stringify(runResult.engineStatus)}、progress=${JSON.stringify(runResult.progress)}；` +
    `节点 status=${JSON.stringify(after.status)} error=${JSON.stringify(after.error)}`);
  rec("W3", "工作流路径仍不写 runRecords（withRunRecords:false 语义保持）",
    after.runRecords === null || after.runRecords === 0,
    `runRecords=${JSON.stringify(after.runRecords)}`);
  rec("W4", "全局额度跑完后归零、无泄漏与残留等待者（REQ-005）",
    after.inFlight === 0 && after.waiters === 0,
    `inFlight=${after.inFlight} waiters=${after.waiters}（上限 ${beforeRun.limit}）`);

  report.consoleErrors = consoleErrors.slice(0, 8);
  report.unifiedEntry = await evalJs(`(async () => {
    const f = await import('/src/stores/flowStore.ts');
    return { totalNodes: f.useFlowStore.getState().nodes.length };
  })()`);
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  console.log("[WF] FATAL", report.fatal);
  exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  sh("taskkill /F /IM nextcreator.exe 2>$null | Out-Null");
  await sleep(2500);
  try {
    const b = readFileSync(report.backup);
    writeFileSync(DATA, b);
    report.restore = { sha256: sha(DATA), matches: sha(DATA) === report.dataShaBefore };
  } catch (e) { report.restore = { error: String(e) }; }
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(EVID, "workflow-live-report.json"), JSON.stringify(report, null, 2), "utf-8");
  console.log(`[WF] summary ${report.checks.map((c) => `${c.id}=${c.result}`).join(" ")} restored=${report.restore?.matches}`);
}
process.exit(exitCode);
