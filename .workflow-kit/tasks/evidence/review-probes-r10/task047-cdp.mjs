// TASK-047 independent verification driver (reviewer-owned, NOT the author's script).
// Talks to a headless Edge over CDP. No system-level input injection.
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9222);
const BASE = `http://127.0.0.1:${PORT}`;

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /5173/.test(t.url));
      if (page) return page;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no CDP page target on 5173');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
    });
  }
  async eval(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    return r.result.value;
  }
  async key(key, code, vk, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  }
  async tab() { await this.key('Tab', 'Tab', 9); }
  async esc() { await this.key('Escape', 'Escape', 27); }
}

// ---- page-side helpers -------------------------------------------------
const RESET_MARKERS = `
  document.querySelectorAll('[data-rev047]').forEach(e => e.removeAttribute('data-rev047'));
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  'reset';
`;

const STOP_INFO = (n) => `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) {
    return { n: ${n}, tag: (el ? el.tagName : 'NONE'), cls: '', inOverlay: false, isBody: true, key: 'BODY' };
  }
  const ov = el.closest('.modal-overlay');
  const cs = getComputedStyle(el);
  let op = 1, p = el;
  while (p && p.nodeType === 1) { const o = parseFloat(getComputedStyle(p).opacity); if (!Number.isNaN(o)) op *= o; p = p.parentElement; }
  const r = el.getBoundingClientRect();
  const marker = el.getAttribute('data-rev047');
  const txt = (el.textContent || '').trim().slice(0, 18);
  return {
    n: ${n},
    tag: el.tagName,
    cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 70),
    role: el.getAttribute('role'),
    id: el.id || null,
    inOverlay: !!ov,
    overlayCls: ov ? ov.className : null,
    overlayInert: ov ? (ov.hasAttribute('inert') || ov.inert === true) : null,
    inertSelf: el.hasAttribute('inert') || el.inert === true,
    inertAncestor: !!el.closest('[inert]'),
    fv: el.matches(':focus-visible'),
    effOpacity: Math.round(op * 100) / 100,
    rect: [Math.round(r.width), Math.round(r.height)],
    marker: marker,
    text: txt,
    key: el.tagName + '|' + (el.className && el.className.toString ? el.className.toString().slice(0,50) : '') + '|' + txt
  };
})()`;

function markStop(n) {
  return `(() => { const el = document.activeElement; if (el && el.setAttribute && !el.hasAttribute('data-rev047')) el.setAttribute('data-rev047', String(${n})); return el ? el.getAttribute('data-rev047') : null; })()`;
}

async function walk(cdp, { max = 200, label = '' } = {}) {
  await cdp.eval(RESET_MARKERS);
  const stops = [];
  let terminated = 'max';
  let sawBody = false;
  for (let i = 1; i <= max; i++) {
    await cdp.tab();
    await new Promise((r) => setTimeout(r, 45));
    const info = await cdp.eval(STOP_INFO(i));
    if (info.isBody) {
      // Tab from the last dockable element wraps to the browser UI / body.
      if (sawBody) { terminated = 'body-again'; stops.push({ ...info, repeatOf: true }); break; }
      sawBody = true;
      stops.push(info);
      continue;
    }
    // Cycle detection by STABLE ELEMENT IDENTITY only (a per-node attribute
    // stamped on first visit). Class/text keys are NOT used: several distinct
    // controls legitimately share tag+class+text (e.g. 3 win-btn, 7 settings-nav-item).
    const existing = await cdp.eval(`(() => { const el = document.activeElement; return el && el.getAttribute ? el.getAttribute('data-rev047') : null; })()`);
    if (existing) { terminated = 'marker-repeat@' + existing + ' (stop#' + i + ')'; stops.push({ ...info, repeatOf: true }); break; }
    await cdp.eval(markStop(i));
    const again = await cdp.eval(`(() => { const el = document.activeElement; return el ? el.getAttribute('data-rev047') : null; })()`);
    if (again !== String(i)) { terminated = 'marker-not-stamped(n=' + again + ')'; stops.push({ ...info, repeatOf: true }); break; }
    info.markerAssigned = again;
    stops.push(info);
  }
  const inOverlay = stops.filter((s) => s.inOverlay);
  const invisible = stops.filter((s) => !s.isBody && s.effOpacity < 0.05);
  return { label, terminated, total: stops.length, inOverlayCount: inOverlay.length, invisibleCount: invisible.length, stops };
}

function overlaysExpr() {
  return `Array.from(document.querySelectorAll('.modal-overlay')).map((el, i) => ({
    i, cls: el.className,
    open: el.classList.contains('open'),
    hasInertAttr: el.hasAttribute('inert'),
    inertProp: el.inert === true,
    inertAttrValue: el.getAttribute('inert'),
    ariaHidden: el.getAttribute('aria-hidden'),
    nominalTabbable: el.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length
  }))`;
}

const out = { startedAt: new Date().toISOString(), steps: {} };

const target = await findTarget();
const cdp = await CDP.connect(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
out.target = { url: target.url, ua: await cdp.eval('navigator.userAgent') };

// wait for app mount
for (let i = 0; i < 60; i++) {
  const ok = await cdp.eval(`!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`);
  if (ok) break;
  await new Promise((r) => setTimeout(r, 500));
}
out.dataMode = await cdp.eval(`(async () => { const m = await import('/src/store.ts'); const s = m.useAppStore.getState(); return { dataMode: s.dataMode, categories: (s.categories||[]).length, entries: (s.entries||[]).length }; })()`);

// Inject the app's own in-memory mock dataset (pure memory, no IPC, no DB write)
// so the main view is populated exactly like the author's richer walk.
out.mockInjected = await cdp.eval(`(async () => {
  const [m, md] = await Promise.all([import('/src/store.ts'), import('/src/mockData.ts')]);
  m.useAppStore.setState({ categories: md.createInitialCategories(), entries: md.createInitialEntries(), dataMode: 'mock' });
  const s = m.useAppStore.getState();
  return { categories: s.categories.length, entries: s.entries.length };
})()`);
await new Promise((r) => setTimeout(r, 400));

// ---------- 1) default all-closed walk ----------
out.steps.overlaysClosed = await cdp.eval(overlaysExpr());
out.steps.walkClosed = await walk(cdp, { label: '默认全关' });

// ---------- 2) ablation: strip inert ----------
out.steps.ablationRemove = await cdp.eval(`(() => {
  const els = Array.from(document.querySelectorAll('.modal-overlay'));
  els.forEach(e => { e.removeAttribute('inert'); e.inert = false; });
  window.__rev047stripped = els.length;
  return els.map(e => ({ cls: e.className, hasInert: e.hasAttribute('inert') }));
})()`);
out.steps.walkAblated = await walk(cdp, { label: '消融：移除 inert' });
await cdp.eval(`(() => { window.__rev047stripped && document.querySelectorAll('.modal-overlay').forEach(e => e.setAttribute('inert','')); return true; })()`);
out.steps.overlaysRestored = await cdp.eval(overlaysExpr());
out.steps.walkRestored = await walk(cdp, { label: '还原 inert' });

// ---------- 3) open settings modal ----------
await cdp.eval(`(async () => { const m = await import('/src/store.ts'); m.useAppStore.setState({ settingsOpen: true }); return true; })()`);
await new Promise((r) => setTimeout(r, 350));
out.steps.overlaysSettingsOpen = await cdp.eval(overlaysExpr());
out.steps.walkSettingsOpen = await walk(cdp, { label: '设置弹窗打开', max: 200 });
out.steps.settingsOpenDetail = await cdp.eval(`(() => {
  const ov = Array.from(document.querySelectorAll('.modal-overlay')).find(e => e.classList.contains('open'));
  if (!ov) return { found: false };
  const els = Array.from(ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));
  const ae = document.activeElement;
  return {
    found: true, cls: ov.className, hasInertAttr: ov.hasAttribute('inert'), inertProp: ov.inert === true,
    nominalTabbable: els.length,
    activeInOverlay: !!(ae && ae.closest && ae.closest('.modal-overlay') === ov),
    activeTag: ae ? ae.tagName : null,
    activeCls: ae && ae.className ? ae.className.toString().slice(0, 60) : null,
    activeFv: ae && ae.matches ? ae.matches(':focus-visible') : null,
    activeOutline: ae ? (getComputedStyle(ae).outlineWidth + ' ' + getComputedStyle(ae).outlineStyle + ' ' + getComputedStyle(ae).outlineColor + ' off=' + getComputedStyle(ae).outlineOffset) : null
  };
})()`);

// ---------- 4) close settings (Esc chain) ----------
await cdp.eval(RESET_MARKERS);
await cdp.eval(`(() => { const ov = Array.from(document.querySelectorAll('.modal-overlay')).find(e => e.classList.contains('open')); const a = ov && ov.querySelector('button,input,[tabindex]:not([tabindex="-1"])'); if (a) a.focus(); return document.activeElement ? document.activeElement.className : null; })()`);
out.steps.focusedInsideBeforeClose = await cdp.eval(`(() => { const ae = document.activeElement; return { tag: ae.tagName, inOverlay: !!ae.closest('.modal-overlay'), inOverlayOpen: !!ae.closest('.modal-overlay.open'), fv: ae.matches(':focus-visible') }; })()`);
await cdp.esc();
await new Promise((r) => setTimeout(r, 400));
out.steps.afterEscSettings = await cdp.eval(`(() => { const ae = document.activeElement; const s = null; return {
  settingsOpenFlag: !document.querySelector('.modal-overlay.open'),
  active: { tag: ae ? ae.tagName : null, cls: ae && ae.className ? ae.className.toString().slice(0,50) : null,
            inOverlay: !!(ae && ae.closest && ae.closest('.modal-overlay')),
            inertAncestor: !!(ae && ae.closest && ae.closest('[inert]')) } }; })()`);
out.steps.walkAfterSettingsClose = await walk(cdp, { label: '设置关闭后' });

// ---------- 5) command palette ----------
await cdp.eval(RESET_MARKERS);
await cdp.key('k', 'KeyK', 75, 2); // Ctrl+K
await new Promise((r) => setTimeout(r, 400));
out.steps.paletteOpen = await cdp.eval(`(() => { const ov = Array.from(document.querySelectorAll('.modal-overlay')).find(e => e.classList.contains('open')); return { anyOpen: !!ov, cls: ov ? ov.className : null, hasInertAttr: ov ? ov.hasAttribute('inert') : null, nominalTabbable: ov ? ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length : 0 }; })()`);
out.steps.walkPaletteOpen = await walk(cdp, { label: '命令面板打开', max: 200 });
out.steps.paletteInputFocused = await cdp.eval(`(() => { const ae=document.activeElement; const ov = ae && ae.closest ? ae.closest('.modal-overlay') : null; return { tag: ae?ae.tagName:null, cls: ae&&ae.className?ae.className.toString().slice(0,50):null, inOverlay: !!ov, ovHasInertAttr: ov?ov.hasAttribute('inert'):null, fv: ae&&ae.matches?ae.matches(':focus-visible'):null }; })()`);
await cdp.esc();
await new Promise((r) => setTimeout(r, 400));
out.steps.paletteAfterEsc = await cdp.eval(overlaysExpr());
out.steps.walkAfterPaletteClose = await walk(cdp, { label: '命令面板关闭后' });

// ---------- 6) lightbox via store state ----------
out.steps.lightboxInjected = await cdp.eval(`(async () => {
  const m = await import('/src/store.ts');
  m.useAppStore.setState({ lightboxUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="%234880c8"/></svg>' });
  return true; })()`);
await new Promise((r) => setTimeout(r, 350));
out.steps.lightboxOpen = await cdp.eval(`(() => { const ov = document.querySelector('.lightbox-overlay'); if (!ov) return { found:false };
  const img = ov.querySelector('img');
  return { found:true, cls: ov.className, open: ov.classList.contains('open'), hasInertAttr: ov.hasAttribute('inert'), inertProp: ov.inert===true,
    imgTabbable: img ? img.tabIndex : null, nominalTabbable: ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length }; })()`);
await cdp.esc();
await new Promise((r) => setTimeout(r, 400));
out.steps.lightboxAfterEsc = await cdp.eval(`(() => { const ov = document.querySelector('.lightbox-overlay'); return { found: !!ov, cls: ov?ov.className:null, open: ov?ov.classList.contains('open'):null, hasInertAttr: ov?ov.hasAttribute('inert'):null, inertProp: ov?ov.inert===true:null }; })()`);
out.steps.walkAfterLightboxClose = await walk(cdp, { label: '灯箱关闭后' });

// ---------- 7) conditional-rendered overlays ----------
out.steps.conditionalRender = await cdp.eval(`(() => ({
  ctxMenuInDom: !!document.querySelector('.ctx-menu'),
  confirmInDom: !!document.querySelector('.confirm-overlay'),
  allOverlayClasses: Array.from(document.querySelectorAll('.modal-overlay')).map(e => e.className)
}))()`);

// ---------- 8) Tab order (contract item 8) ----------
out.steps.tabOrderClosed = (await walk(cdp, { label: '顺序核对' })).stops.map((s) => `${s.n}:${s.tag}.${(s.cls || '').split(' ')[0]}`);

// screenshot of settings-open focus ring (reviewer's own evidence)
await cdp.eval(`(async () => { const m = await import('/src/store.ts'); m.useAppStore.setState({ settingsOpen: true }); return true; })()`);
await new Promise((r) => setTimeout(r, 400));
for (let i = 0; i < 3; i++) { const info = await cdp.eval(STOP_INFO(0)); if (info.inOverlay) break; await cdp.tab(); await new Promise((r) => setTimeout(r, 60)); }
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(process.env.SHOT_OUT || 'rev047-settings-open.png', Buffer.from(shot.data, 'base64'));
out.steps.screenshotActive = await cdp.eval(`(() => { const ae=document.activeElement; return { tag: ae?ae.tagName:null, cls: ae&&ae.className?ae.className.toString().slice(0,60):null, inOverlay: !!(ae&&ae.closest&&ae.closest('.modal-overlay.open')), fv: ae&&ae.matches?ae.matches(':focus-visible'):null }; })()`);

out.finishedAt = new Date().toISOString();
writeFileSync(process.env.OUT_FILE || 'rev047-out.json', JSON.stringify(out, null, 1));
console.log('OK ->', process.env.OUT_FILE || 'rev047-out.json');
console.log('closed walk:', out.steps.walkClosed.total, 'inOverlay', out.steps.walkClosed.inOverlayCount, 'term', out.steps.walkClosed.terminated);
console.log('ablated walk:', out.steps.walkAblated.total, 'inOverlay', out.steps.walkAblated.inOverlayCount, 'term', out.steps.walkAblated.terminated);
console.log('restored walk:', out.steps.walkRestored.total, 'inOverlay', out.steps.walkRestored.inOverlayCount, 'term', out.steps.walkRestored.terminated);
console.log('settings open walk:', out.steps.walkSettingsOpen.total, 'inOverlay', out.steps.walkSettingsOpen.inOverlayCount, 'term', out.steps.walkSettingsOpen.terminated);
process.exit(0);
