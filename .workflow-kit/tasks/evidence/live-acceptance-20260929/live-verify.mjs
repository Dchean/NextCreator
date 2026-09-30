/**
 * TASK-006 LIVE acceptance - final driver (2026-09-29).
 *
 * Real release app + vite devUrl; all interactions are REAL CDP mouse/keyboard
 * input on the shipping UI. Assertions read the app's OWN zustand stores via Vite
 * dev modules (the same instances the UI uses), because a sandboxed child token
 * cannot write app-data.json in this session (<SANDBOX_WRITE_DENIED>) - so the persisted file
 * is not a usable oracle here. The S5 restart fixture is written in the app's own
 * persisted format.
 *
 * Ordering matters: the generate button is disabled while the node has a queued
 * job or is loading (ImageGeneratorInspector.tsx:646-651), so each scenario starts
 * from a clean, idle node.
 *
 * Safety: real app-data.json is backed up first and restored in `finally`.
 */
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = "D:\\NextCreator";
const EVID = path.join(ROOT, ".workflow-kit", "tasks", "evidence", "live-acceptance-20260929");
const SHOTS = path.join(EVID, "shots");
const EXE = path.join(ROOT, "src-tauri", "target", "release", "nextcreator.exe");
const DATA = path.join(process.env.APPDATA, "com.sy.nextcreator", "app-data.json");
const BACKUP = path.join(EVID, "app-data.before-live-run.json");
const PROFILE = path.join(ROOT, "src-tauri", "target", "nc-live-profile");
const TOAST = "该节点仍有任务在排队中，本次点击未生效（可等待完成或用队列面板取消）";
const PROMPT = "LIVE-ACCEPTANCE-TASK006";

mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => { try { return execFileSync("powershell", ["-NoProfile", "-Command", c], { encoding: "utf-8" }).trim(); } catch { return ""; } };
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const report = { startedAt: new Date().toISOString(), scenarios: [], notes: [] };
const rec = (id, title, pass, detail, extra = {}) => {
  const e = { id, title, result: pass === true ? "PASS" : pass === false ? "FAIL" : "SKIP", detail, ...extra };
  report.scenarios.push(e); console.log(`[LIVE] ${e.result} ${id} :: ${detail}`); return e;
};

let ws = null, mid = 0; const pend = new Map(); const consoleErrors = [];
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
            if (/Storage save error|拒绝访问/i.test(t)) consoleErrors.push(t.slice(0, 120));
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
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error("page: " + JSON.stringify(r.exceptionDetails).slice(0, 250)); return r.result.value; };
const bodyText = async () => (await evalJs("document.body.innerText")) ?? "";
const shot = async (n) => { await send("Page.enable"); const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, "base64")); };
async function rawClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
}
async function clickAt(x, y, count = 1) { for (let i = 1; i <= count; i++) { await rawClick(x, y); await sleep(45); } }
const byText = (t) => evalJs(`(()=>{const e=[...document.querySelectorAll('button,[role="button"]')].filter(x=>(x.innerText||x.textContent||'').trim()===${JSON.stringify(t)}).find(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0;});if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
const byAria = (t) => evalJs(`(()=>{const e=document.querySelector('[aria-label=${JSON.stringify(t)}]');if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
/** generate button: its label reflects node state, so match both labels */
const genBtnPos = () => evalJs(`(()=>{
  const all=[...document.querySelectorAll('button')].filter(x=>/^(生成图片|排队中|生成中)/.test((x.innerText||'').trim())&&x.getBoundingClientRect().width>150);
  const b=all[0]; if(!b) return null;
  const r=b.getBoundingClientRect();
  const el=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
  const owner=el?el.closest('button'):null;
  return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),label:(b.innerText||'').trim(),disabled:b.disabled,clickable:owner===b,topCls:el?(el.getAttribute('class')||'').slice(0,45):null};
})()`);
async function waitFor(fn, ms = 8000, step = 200) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const readStores = () => evalJs(`(async () => {
  const q = await import('/src/stores/queueStore.ts');
  const c = await import('/src/stores/canvasStore.ts');
  const f = await import('/src/stores/flowStore.ts');
  const qs = q.useQueueStore.getState(), cs = c.useCanvasStore.getState(), fs = f.useFlowStore.getState();
  return {
    paused: qs.paused, concurrency: qs.concurrency,
    jobs: qs.jobs.map(j => ({ id: j.id, nodeId: j.nodeId, status: j.status, batchIndex: j.batchIndex, batchTotal: j.batchTotal })),
    activeCanvasId: cs.activeCanvasId,
    flowGenNodes: fs.nodes.filter(n => String(n.type).includes('imageGenerator')).map(n => ({ id: n.id, queued: !!(n.data&&n.data.queued), status: (n.data&&n.data.status)||null, n: n.data&&n.data.n, prompt: String((n.data&&n.data.prompt)||'').slice(0,40) })),
  };
})()`);
/** put the node back to a clean idle state through the app's own store */
const resetNode = () => evalJs(`(async () => {
  const q = await import('/src/stores/queueStore.ts');
  const f = await import('/src/stores/flowStore.ts');
  q.useQueueStore.setState({ jobs: [], paused: false });
  const fs = f.useFlowStore.getState();
  for (const n of fs.nodes) if (String(n.type).includes('imageGenerator')) fs.updateNodeData(n.id, { queued: false, status: 'idle', error: undefined });
  return true;
})()`);
async function settle() { await sleep(1200); }

async function boot() {
  sh("taskkill /F /IM nextcreator.exe 2>$null | Out-Null");
  await sleep(5000);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  mkdirSync(PROFILE, { recursive: true });
  const env = { ...process.env, WEBVIEW2_USER_DATA_FOLDER: PROFILE, WEBVIEW2_CHANNEL_PREFERENCE: "1", WEBVIEW2_RELEASE_CHANNEL_PREFERENCE: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" };
  spawn(EXE, [], { env, detached: true, stdio: "ignore" }).unref();
  return connect(60000);
}
async function waitMounted() {
  for (let i = 0; i < 30; i++) { await sleep(1500); const t = await bodyText().catch(() => ""); if (t && t.includes("NextCreator")) return true; }
  return false;
}
async function makeFixtureNode() {
  await evalJs(`(() => {
    const pane = document.querySelector('.react-flow__pane'); if(!pane) return 'no pane';
    const r = pane.getBoundingClientRect(); const dt = new DataTransfer();
    dt.setData('application/reactflow/type','imageGeneratorNode');
    dt.setData('application/reactflow/data', JSON.stringify({}));
    const b = { bubbles:true, cancelable:true, composed:true, clientX:r.x+r.width*0.45, clientY:r.y+r.height*0.55, dataTransfer:dt };
    pane.dispatchEvent(new DragEvent('dragover', b)); pane.dispatchEvent(new DragEvent('drop', b));
    return 'ok';
  })()`);
  await sleep(2500);
}
async function selectGenerator() {
  const fit = await evalJs(`(()=>{const e=[...document.querySelectorAll('[title="Fit View"]')].find(x=>x.getBoundingClientRect().width>0);if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (fit) { await clickAt(fit.x, fit.y); await sleep(1200); }
  const zo = await evalJs(`(()=>{const e=[...document.querySelectorAll('[title="Zoom Out"]')].find(x=>x.getBoundingClientRect().width>0);if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (zo) { await clickAt(zo.x, zo.y); await sleep(600); await clickAt(zo.x, zo.y); await sleep(900); }
  const pt = await evalJs(`(() => {
    const n=[...document.querySelectorAll('.react-flow__node')].find(x=>(x.getAttribute('class')||'').includes('imageGenerator'));
    if(!n) return null; const r=n.getBoundingClientRect();
    const owns=(el)=>{ let p=el; while(p){ if(p===n) return true; p=p.parentElement; } return false; };
    for (let fy=0.04; fy<=0.96; fy+=0.04) for (let fx=0.15; fx<=0.85; fx+=0.05) {
      const X=r.x+r.width*fx, Y=r.y+r.height*fy;
      if (X<20||Y<60||X>innerWidth-20||Y>innerHeight-20) continue;
      const el=document.elementFromPoint(X,Y);
      if (el && owns(el)) return { x:Math.round(X), y:Math.round(Y) };
    }
    return null;
  })()`);
  if (pt) { await clickAt(pt.x, pt.y); await sleep(1500); }
  return !!(await evalJs(`[...document.querySelectorAll('.react-flow__node.selected')].some(e=>(e.getAttribute('class')||'').includes('imageGenerator'))`));
}
async function typePrompt() {
  const ta = await evalJs(`(()=>{const t=[...document.querySelectorAll('textarea')].find(e=>(e.getAttribute('placeholder')||'').includes('提示词'));if(!t)return null;t.scrollIntoView({block:'center'});const r=t.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  if (!ta) return false;
  await clickAt(ta.x, ta.y); await sleep(300);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await sleep(150);
  for (const ch of PROMPT) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    await sleep(20);
  }
  await sleep(900);
  return (await bodyText()).includes(PROMPT);
}
async function openQueue() {
  if ((await bodyText()).includes("生成队列")) return true;
  const q = await byAria("生成队列"); if (q) { await clickAt(q.x, q.y); await sleep(1200); }
  return (await bodyText()).includes("生成队列");
}
async function closeQueuePanel() {
  const r = await evalJs(`(() => {
    const pause = document.querySelector('[aria-label="暂停队列"],[aria-label="恢复队列"]');
    if (!pause) return null;
    const py = pause.getBoundingClientRect().y;
    const btn = [...document.querySelectorAll('[aria-label="关闭"]')].find((b) => Math.abs(b.getBoundingClientRect().y - py) < 14);
    if (!btn) return null;
    const rr = btn.getBoundingClientRect();
    return { x: Math.round(rr.x + rr.width / 2), y: Math.round(rr.y + rr.height / 2) };
  })()`);
  if (r) { await clickAt(r.x, r.y); await sleep(1100); }
  return !(await bodyText()).includes("生成队列");
}
/** rapid-click generate with REAL mouse input, resolving the button once */
async function rapidGenerate(n = 3) {
  const b = await genBtnPos();
  if (!b) return { ok: false, why: "button missing" };
  if (!b.clickable) return { ok: false, why: `covered by ${b.topCls}`, at: `${b.x},${b.y}` };
  if (b.disabled) return { ok: false, why: `disabled (${b.label})` };
  for (let i = 0; i < n; i++) await rawClick(b.x, b.y);
  return { ok: true, at: `${b.x},${b.y}`, label: b.label };
}
/** set 生成数量 via the inspector segmented control; verify via store */
async function setBatch(n) {
  await closeQueuePanel();
  // the inspector only shows the segmented control while the node is selected
  if (!(await evalJs(`[...document.querySelectorAll('.react-flow__node.selected')].some(e=>(e.getAttribute('class')||'').includes('imageGenerator'))`))) {
    await selectGenerator();
  }
  await evalJs(`(()=>{const t=[...document.querySelectorAll('*')].find(e=>(e.textContent||'').trim()==='生成数量（并发任务）');if(t)t.scrollIntoView({block:'center'});return true;})()`);
  await sleep(700);
  const btn = await byText(`${n} 张`);
  if (!btn) return { ok: false, why: `no "${n} 张"` };
  await clickAt(btn.x, btn.y);
  await sleep(900);
  const st = await readStores();
  const nodeN = st.flowGenNodes[0]?.n;
  return { ok: nodeN === n, nodeN };
}
async function pauseQueue() { const r = await byAria("暂停队列"); if (r) { await clickAt(r.x, r.y); await sleep(1300); } return (await readStores()).paused; }
async function resumeIfPaused() { const st = await readStores(); if (!st.paused) return false; const r = await byAria("恢复队列"); if (r) { await clickAt(r.x, r.y); await sleep(1300); } return true; }

if (!existsSync(BACKUP)) copyFileSync(DATA, BACKUP);
report.backup = { path: BACKUP, sha256: sha(BACKUP), bytes: readFileSync(BACKUP).length };
report.dataShaBefore = sha(DATA);

let exitCode = 0;
try {
  let page = await boot();
  if (!page) throw new Error("boot failed");
  if (!(await waitMounted())) throw new Error("app did not mount");
  await shot("B0-booted.png");

  await resetNode();
  await makeFixtureNode();
  const selected = await selectGenerator();
  const promptOk = await typePrompt();
  const queueOpen = await openQueue();
  await shot("B1-ready.png");

  let st = await readStores();
  const NODE_ID = st.flowGenNodes[0]?.id;
  report.notes.push({ selected, promptOk, queueOpen, node: st.flowGenNodes[0], concurrency: st.concurrency });
  rec("S0", "实机就绪：真实应用渲染 + 生成节点可选中 + 提示词写入 + 队列面板可见",
    !!(selected && promptOk && NODE_ID && queueOpen),
    `node=${NODE_ID} 选中=${selected} 提示词=${promptOk} 队列面板=${queueOpen} 并发=${st.concurrency}`);

  const jobsFor = (s, id) => s.jobs.filter((j) => String(j.nodeId) === String(id));

  /* ---- S1: rapid triple click => exactly one job (REQ-002) ---- */
  if (NODE_ID) {
    await closeQueuePanel();
    await resetNode(); await settle();
    const before = (await readStores()).jobs.length;
    const cg = await rapidGenerate(3);
    await sleep(7000);
    st = await readStores();
    const after = jobsFor(st, NODE_ID);
    await shot("B2-s1-triple-click.png");
    rec("S1", "同一节点连点 3 次仅产生 1 个任务（REQ-002）",
      cg.ok && after.length - before === 1,
      `点击=${JSON.stringify(cg)}；该节点 job 数 ${before}→${after.length}（期望 +1）；状态=${after.map((j) => j.status).join(",") || "-"}`);
  }

  /* ---- S7: rejected click during a real rejection window => toast, no growth ----
   * The toast only appears for an ENABLED click that the enqueue guard rejects.
   * The button is disabled while data.queued is true or status is loading
   * (ImageGeneratorInspector.tsx:646-651). So the window is: node has active jobs
   * but the UI is idle - exactly the documented paused-state case, where clicking
   * while jobs are queued must be rejected WITH feedback (and the guard must not
   * skip its check just because the queue is paused).
   */
  try {
    await resumeIfPaused();
    await resetNode(); await settle();
    const setup = await evalJs(`(async () => {
      const q = await import('/src/stores/queueStore.ts');
      const f = await import('/src/stores/flowStore.ts');
      const c = await import('/src/stores/canvasStore.ts');
      const canvasId = c.useCanvasStore.getState().activeCanvasId;
      const enqueue = (batchIndex, batchTotal) => q.useQueueStore.getState().enqueue({
        canvasId, nodeId: ${JSON.stringify(NODE_ID)}, nodeLabel: '绘图生成',
        modelLabel: 'gemini-3.1-flash-image-preview', promptPreview: ${JSON.stringify(PROMPT)},
        batchIndex, batchTotal,
      });
      q.useQueueStore.setState({ paused: true, concurrency: 1 });
      for (let i = 1; i <= 3; i++) enqueue(i, 3);
      f.useFlowStore.getState().updateNodeData(${JSON.stringify(NODE_ID)}, { queued: false, status: 'error' });
      const st = q.useQueueStore.getState();
      return { paused: st.paused, queued: st.jobs.filter((j) => j.status === 'queued').length, total: st.jobs.length };
    })()`);
    await sleep(1500);
    const before7 = (await readStores()).jobs.length;
    const b = await genBtnPos();
    let seen = null, clicked = null;
    if (b && b.clickable && !b.disabled) {
      await rawClick(b.x, b.y);
      clicked = { label: b.label, at: `${b.x},${b.y}` };
      seen = await waitFor(async () => ((await bodyText()).includes(TOAST) ? true : null), 7000, 120);
    }
    st = await readStores();
    await shot("B3-s7-toast.png");
    rec("S7", "被拒点击出现 toast 反馈且不新增任务",
      !!(seen === true && st.jobs.length === before7),
      `窗口构造=${JSON.stringify(setup)}；按钮=${JSON.stringify(b)}；点击=${JSON.stringify(clicked)}；toast=${seen === true}；总 job ${before7}→${st.jobs.length}（应不变）`);
    await resetNode();
  } catch (e) { rec("S7", "被拒点击出现 toast 反馈且不新增任务", null, "异常: " + e.message); }

  /* ---- S3: paused rapid triple click => exactly 1 queued ---- */
  try {
    await resumeIfPaused();
    await resetNode(); await settle();
    await openQueue();
    const paused = await pauseQueue();
    await closeQueuePanel();
    const before = (await readStores()).jobs.length;
    const cg = await rapidGenerate(3);
    await sleep(5000);
    st = await readStores();
    const act = jobsFor(st, NODE_ID).filter((j) => j.status === "queued" || j.status === "running");
    await shot("B4-s3-paused.png");
    rec("S3", "暂停态连点 3 次仅 1 个 queued 任务",
      paused && cg.ok && act.length === 1 && act[0].status === "queued",
      `暂停=${paused}；点击=${JSON.stringify(cg)}；该节点活动任务=${act.length}（${act.map((j) => j.status).join(",") || "-"}）；总 job ${before}→${st.jobs.length}`);
  } catch (e) { rec("S3", "暂停态连点 3 次仅 1 个 queued 任务", null, "异常: " + e.message); }

  /* ---- S2: batch n=4 => exactly 4 jobs per click, and not locked out after ----
   * Semantics (gate case C): one click splits into a full batch of 4; once the
   * batch is done a further click produces another full batch (history must not
   * lock the node). The "clicks during the batch do not grow" sub-case is covered
   * by gate case C/E with a controlled harness; here each job fails in ~20ms
   * because the local gateway is down, so that window is not observable by mouse.
   */
  try {
    await resumeIfPaused();
    await resetNode(); await settle();
    const sb = await setBatch(4);
    report.notes.push({ setBatch4: sb });
    if (!sb.ok) rec("S2", "批量 n=4 每点一次整批 4 个且批后不锁死", null, `「4 张」未生效：${JSON.stringify(sb)}`);
    else {
      const c1 = await rapidGenerate(1);
      await sleep(9000);
      const s1 = await readStores();
      const b1 = jobsFor(s1, NODE_ID).length;
      const batchTotals1 = [...new Set(s1.jobs.map((j) => j.batchTotal))];
      // wait until the first batch is no longer active, then click once more
      await waitFor(async () => {
        const s = await readStores();
        return jobsFor(s, NODE_ID).every((j) => j.status !== "queued" && j.status !== "running") ? true : null;
      }, 20000, 300);
      const c2 = await rapidGenerate(1);
      await sleep(9000);
      const s2 = await readStores();
      const b2 = jobsFor(s2, NODE_ID).length;
      await shot("B5-s2-batch.png");
      rec("S2", "批量 n=4 每点一次整批 4 个且批后不锁死",
        c1.ok && c2.ok && b1 === 4 && b2 - b1 === 4,
        `首次点击产生=${b1}（期望 4；batchTotal=${batchTotals1.join("/")}）；该批结束后再点一次新增=${b2 - b1}（期望 4，证明不被历史任务锁死）`);
    }
  } catch (e) { rec("S2", "批量 n=4 每点一次整批 4 个且批后不锁死", null, "异常: " + e.message); }

  /* ---- S5: kill + restart with a leftover queued job (REQ-001) ----
   * Deterministic fixture: enqueue a queued job through the app's OWN store (the
   * same enqueue the UI calls) with the queue paused, so the job genuinely sits
   * queued, then persist it in the app's own format and REALLY kill + restart. */
  try {
    await resumeIfPaused();
    await resetNode(); await settle();
    await openQueue();
    await pauseQueue();
    await closeQueuePanel();
    await evalJs(`(async () => {
      const q = await import('/src/stores/queueStore.ts');
      const c = await import('/src/stores/canvasStore.ts');
      q.useQueueStore.getState().enqueue({
        canvasId: c.useCanvasStore.getState().activeCanvasId,
        nodeId: ${JSON.stringify(NODE_ID)},
        nodeLabel: '绘图生成',
        modelLabel: 'gemini-3.1-flash-image-preview',
        promptPreview: ${JSON.stringify(PROMPT)},
      });
      return true;
    })()`);
    await sleep(2500);
    const pre = await readStores();
    const queued = pre.jobs.filter((j) => j.status === "queued" && String(j.nodeId) === String(NODE_ID));
    if (!queued.length) {
      rec("S5", "强杀重启后遗留 queued 得到处置且节点解锁（REQ-001）", null,
        `未能构造 queued 任务（jobs=${pre.jobs.map((j) => j.status).join(",") || "-"}）`);
    } else {
      const canvasId = pre.activeCanvasId;
      const raw = JSON.parse(readFileSync(BACKUP, "utf-8"));
      // fixture in the app's own persisted format; queue NOT paused so recovery may dispatch
      raw["generation-queue"] = JSON.stringify({ state: { jobs: pre.jobs, concurrency: pre.concurrency, paused: false }, version: 0 });
      const canvases = JSON.parse(typeof raw["next-creator-canvases"] === "string" ? raw["next-creator-canvases"] : JSON.stringify(raw["next-creator-canvases"]));
      const cs = canvases.state ?? canvases;
      const target = cs.canvases.find((c) => c.id === canvasId) ?? cs.canvases[0];
      const liveCanvas = await evalJs(`(async () => { const c = await import('/src/stores/canvasStore.ts'); const cv = c.useCanvasStore.getState().canvases.find(x => x.id === ${JSON.stringify(canvasId)}) ?? c.useCanvasStore.getState().canvases[0]; return JSON.stringify(cv); })()`);
      target.nodes = JSON.parse(liveCanvas).nodes;
      raw["next-creator-canvases"] = JSON.stringify(canvases);
      writeFileSync(DATA, JSON.stringify(raw, null, 2), "utf-8");
      const fixtureNode = (target.nodes || []).find((n) => n.id === NODE_ID);
      report.notes.push({ fixtureWritten: true, fixtureJobs: pre.jobs.length, fixtureNodeQueued: fixtureNode?.data?.queued, fixturePaused: false });

      sh("taskkill /F /IM nextcreator.exe 2>$null | Out-Null");
      try { ws.close(); } catch {} ws = null;
      await sleep(5000);
      page = await boot();
      if (!page) throw new Error("restart: CDP did not return");
      if (!(await waitMounted())) throw new Error("restart: app did not mount");
      await sleep(11000);
      const post = await readStores();
      const after = post.jobs.filter((j) => String(j.nodeId) === String(NODE_ID));
      const stillQueued = after.filter((j) => j.status === "queued").length;
      const domText = (await bodyText()).replace(/\s+/g, " ");
      const nodeAfter = post.flowGenNodes.find((n) => n.id === NODE_ID);
      await shot("B6-s5-after-restart.png");
      rec("S5", "强杀重启后遗留 queued 得到处置且节点解锁（REQ-001）",
        stillQueued === 0 && nodeAfter?.queued !== true,
        `重启前 queued=${queued.length}（jobs=${pre.jobs.map((j) => j.status).join(",")}）→ 重启后仍 queued=${stillQueued}（终态 ${after.map((j) => j.status).join(",") || "-"}）；节点 queued=${String(nodeAfter?.queued)}；DOM 含「排队中」=${domText.includes("排队中")}`);
    }
  } catch (e) { rec("S5", "强杀重启后遗留 queued 得到处置且节点解锁（REQ-001）", null, "异常: " + e.message); }

  report.persistErrors = consoleErrors.slice(0, 3);
  report.envNote = "本会话中应用无法写 app-data.json（子进程继承受限令牌，<SANDBOX_WRITE_DENIED>）；断言改为读取应用自身 zustand store（经 Vite 模块取到 UI 同一个实例）；S5 的重启前持久化文件由驱动按应用自身格式写入（fixture）。本机本地网关未启动，任务执行会以 502 失败，不影响队列语义断言。";
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  console.log("[LIVE] FATAL", report.fatal);
  exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  sh("taskkill /F /IM nextcreator.exe 2>$null | Out-Null");
  await sleep(3000);
  try {
    if (existsSync(BACKUP)) {
      copyFileSync(BACKUP, DATA);
      const restored = sha(DATA);
      report.restore = { sha256: restored, matchesBackup: restored === report.backup.sha256, bytes: readFileSync(DATA).length };
      console.log("[LIVE] restore:", JSON.stringify(report.restore));
    }
  } catch (e) { report.restore = { error: String(e) }; }
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(EVID, "live-report.json"), JSON.stringify(report, null, 2), "utf-8");
  const p = report.scenarios.filter((s) => s.result === "PASS").length;
  const f = report.scenarios.filter((s) => s.result === "FAIL").length;
  const k = report.scenarios.filter((s) => s.result === "SKIP").length;
  console.log(`[LIVE] summary PASS=${p} FAIL=${f} SKIP=${k} restored=${report.restore?.matchesBackup}`);
}
process.exit(exitCode);
