// TASK-047 reviewer driver v3 — scenario-isolated, fresh page per scenario.
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9222);
const BASE = `http://127.0.0.1:${PORT}`;
const APP = 'http://localhost:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`${BASE}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /5173/.test(t.url));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('no CDP page target');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
  async eval(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
    return r.result.value;
  }
  async key(key, code, vk, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  }
  tab() { return this.key('Tab', 'Tab', 9); }
  esc() { return this.key('Escape', 'Escape', 27); }
}

const RESET = `document.querySelectorAll('[data-rev047]').forEach(e => e.removeAttribute('data-rev047'));'ok'`;

const STOP = (n) => `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { n:${n}, tag: el?el.tagName:'NONE', isBody:true };
  const ov = el.closest('.modal-overlay');
  let op = 1, p = el;
  while (p && p.nodeType === 1) { const o = parseFloat(getComputedStyle(p).opacity); if (!Number.isNaN(o)) op *= o; p = p.parentElement; }
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { n:${n}, tag: el.tagName,
    cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0,60),
    text: (el.textContent||'').trim().slice(0,16),
    inOverlay: !!ov, overlayCls: ov?ov.className:null, overlayOpen: ov?ov.classList.contains('open'):null,
    inertAncestor: !!el.closest('[inert]'), fv: el.matches(':focus-visible'),
    effOpacity: Math.round(op*100)/100, rect:[Math.round(r.width),Math.round(r.height)],
    outline: cs.outlineWidth+' '+cs.outlineStyle+' '+cs.outlineColor+' off='+cs.outlineOffset };
})()`;

async function walk(cdp, { max = 220, label = '' } = {}) {
  await cdp.eval(RESET);
  const stops = []; let terminated = 'max'; let sawBody = false;
  for (let i = 1; i <= max; i++) {
    await cdp.tab();
    await sleep(40);
    const info = await cdp.eval(STOP(i));
    if (info.isBody) { if (sawBody) { terminated = 'body-again@' + i; stops.push({ ...info, repeatOf: true }); break; } sawBody = true; stops.push(info); continue; }
    // identity = per-node attribute stamped on first visit (never class/text)
    const existing = await cdp.eval(`(() => { const el=document.activeElement; return el&&el.getAttribute?el.getAttribute('data-rev047'):null; })()`);
    if (existing) { terminated = 'marker-repeat@' + existing + '@stop' + i; stops.push({ ...info, repeatOf: true }); break; }
    await cdp.eval(`(() => { const el=document.activeElement; if (el) el.setAttribute('data-rev047', String(${i})); return true; })()`);
    info.markerAssigned = i;
    stops.push(info);
  }
  const inOv = stops.filter((s) => s.inOverlay && !s.repeatOf);
  const invis = stops.filter((s) => !s.isBody && s.effOpacity < 0.05 && !s.repeatOf);
  return { label, terminated, total: stops.length, inOverlayCount: inOv.length, invisibleCount: invis.length,
    focusVisibleInOverlay: inOv.filter((s) => s.fv).length, stops };
}

const OVERLAYS = `Array.from(document.querySelectorAll('.modal-overlay')).map((el,i)=>({
  i, cls: el.className, open: el.classList.contains('open'),
  hasInertAttr: el.hasAttribute('inert'), inertProp: el.inert===true, inertAttrValue: el.getAttribute('inert'),
  ariaHidden: el.getAttribute('aria-hidden'),
  nominalTabbable: el.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length,
  firstControl: (()=>{const c=el.querySelector('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])');return c?c.tagName+'.'+(c.className||'').toString().split(' ')[0]:null;})()
}))`;

const out = { startedAt: new Date().toISOString(), scenarios: {} };
const cdp = await CDP.connect((await findTarget()).webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
try { await cdp.send('Accessibility.enable'); } catch {}
out.ua = await cdp.eval('navigator.userAgent');

async function fresh({ mock = true } = {}) {
  await cdp.send('Page.navigate', { url: APP });
  for (let i = 0; i < 80; i++) {
    const ok = await cdp.eval(`!!document.querySelector('#root') && document.querySelector('#root').children.length > 0`).catch(() => false);
    if (ok) break;
    await sleep(250);
  }
  await sleep(500);
  if (mock) {
    await cdp.eval(`(async () => {
      const [m, md] = await Promise.all([import('/src/store.ts'), import('/src/mockData.ts')]);
      m.useAppStore.setState({ categories: md.createInitialCategories(), entries: md.createInitialEntries(), dataMode: 'mock' });
      return true; })()`);
    await sleep(450);
  }
  return cdp.eval(`(async () => { const m = await import('/src/store.ts'); const s = m.useAppStore.getState();
    return { dataMode: s.dataMode, categories: (s.categories||[]).length, entries: (s.entries||[]).length, settingsOpen: !!s.settingsOpen, lightboxUrl: s.lightboxUrl||null }; })()`);
}

// ---------- S1: default all-closed ----------
out.scenarios.S1_state = await fresh();
out.scenarios.S1_overlays = await cdp.eval(OVERLAYS);
out.scenarios.S1_walk = await walk(cdp, { label: 'S1 默认全关' });
out.scenarios.S1_axClosed = await cdp.eval(`(() => { try { return { note: 'ax probe below' }; } catch(e) { return {err:String(e)}; } })()`);
try {
  const ax = await cdp.send('Accessibility.getFullAXTree', { depth: -1 });
  const names = ['通用', '外观', '刷新间隔', '自动刷新'];
  const hit = {};
  for (const nm of names) hit[nm] = ax.nodes.filter((n) => (n.name && n.name.value === nm) && !n.ignored).length;
  out.scenarios.S1_axNamesClosed = hit;
} catch (e) { out.scenarios.S1_axNamesClosed = { error: String(e) }; }

// ---------- S2: ablation (closed) then reload ----------
out.scenarios.S2_strip = await cdp.eval(`(() => { const els = Array.from(document.querySelectorAll('.modal-overlay'));
  els.forEach(e => { e.removeAttribute('inert'); e.inert = false; });
  return { stripped: els.length, now: els.map(e=>e.hasAttribute('inert')) }; })()`);
out.scenarios.S2_walkAblated = await walk(cdp, { label: 'S2 消融：移除 inert' });
out.scenarios.S2_stateAfterReload = await fresh();
out.scenarios.S2_overlaysAfterReload = await cdp.eval(OVERLAYS);
out.scenarios.S2_walkRestored = await walk(cdp, { label: 'S2 还原（重载后）' });

// ---------- S3: settings modal OPEN ----------
await cdp.eval(`(async () => { const m = await import('/src/store.ts'); m.useAppStore.setState({ settingsOpen: true }); return true; })()`);
await sleep(450);
out.scenarios.S3_overlays = await cdp.eval(OVERLAYS);
out.scenarios.S3_walk = await walk(cdp, { label: 'S3 设置弹窗打开', max: 220 });
out.scenarios.S3_openDetail = await cdp.eval(`(() => {
  const ov = Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  if (!ov) return {found:false};
  const ctrl = Array.from(ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));
  const ae = document.activeElement;
  return { found:true, cls: ov.className, hasInertAttr: ov.hasAttribute('inert'), inertProp: ov.inert===true,
    navItemCount: ov.querySelectorAll('.settings-nav-item').length, nominalTabbable: ctrl.length,
    activeInThisOverlay: !!(ae && ae.closest && ae.closest('.modal-overlay')===ov),
    activeTag: ae?ae.tagName:null, activeCls: ae&&ae.className?ae.className.toString().slice(0,50):null,
    activeFv: ae&&ae.matches?ae.matches(':focus-visible'):null,
    activeOutline: ae?getComputedStyle(ae).outlineWidth+' '+getComputedStyle(ae).outlineStyle+' '+getComputedStyle(ae).outlineColor+' off='+getComputedStyle(ae).outlineOffset:null };
})()`);
try {
  const ax = await cdp.send('Accessibility.getFullAXTree', { depth: -1 });
  const names = ['通用', '外观', '刷新间隔', '自动刷新'];
  const hit = {};
  for (const nm of names) hit[nm] = ax.nodes.filter((n) => (n.name && n.name.value === nm) && !n.ignored).length;
  out.scenarios.S3_axNamesOpen = hit;
} catch (e) { out.scenarios.S3_axNamesOpen = { error: String(e) }; }

// ---------- S4: focus inside overlay, then Esc ----------
await cdp.eval(`(() => { const ov = Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  const c = ov.querySelector('.settings-nav-item'); if (c) c.focus(); return true; })()`);
await sleep(200);
out.scenarios.S4_beforeClose = await cdp.eval(`(() => { const ae=document.activeElement; return { tag:ae.tagName, cls:ae.className.toString().slice(0,40),
  inOpenOverlay: !!ae.closest('.modal-overlay.open'), fv: ae.matches(':focus-visible'),
  outline: getComputedStyle(ae).outlineWidth+' '+getComputedStyle(ae).outlineStyle+' '+getComputedStyle(ae).outlineColor }; })()`);
await cdp.esc();
await sleep(450);
out.scenarios.S4_afterEsc = await cdp.eval(`(() => { const ae=document.activeElement; const ovs=Array.from(document.querySelectorAll('.modal-overlay'));
  return { anyOpen: ovs.some(e=>e.classList.contains('open')), allClosedHaveInert: ovs.every(e=>e.classList.contains('open')||e.hasAttribute('inert')),
    active: { tag: ae?ae.tagName:null, cls: ae&&ae.className?ae.className.toString().slice(0,40):null,
      inOverlay: !!(ae&&ae.closest&&ae.closest('.modal-overlay')), inertAncestor: !!(ae&&ae.closest&&ae.closest('[inert]')) } }; })()`);
out.scenarios.S4_walkAfterClose = await walk(cdp, { label: 'S4 设置关闭后' });

// ---------- S5: command palette ----------
await cdp.key('k', 'KeyK', 75, 2);
await sleep(450);
out.scenarios.S5_open = await cdp.eval(`(() => { const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  return { anyOpen: !!ov, cls: ov?ov.className:null, hasInertAttr: ov?ov.hasAttribute('inert'):null,
    nominalTabbable: ov?ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length:0,
    activeInOverlay: !!(document.activeElement&&document.activeElement.closest&&document.activeElement.closest('.modal-overlay')) }; })()`);
out.scenarios.S5_walkOpen = await walk(cdp, { label: 'S5 命令面板打开', max: 120 });
await cdp.esc();
await sleep(450);
out.scenarios.S5_afterEsc = await cdp.eval(`(() => { const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  return { anyOpen: !!ov }; })()`);
out.scenarios.S5_walkAfterClose = await walk(cdp, { label: 'S5 命令面板关闭后' });

// ---------- S6: lightbox ----------
out.scenarios.S6_inject = await cdp.eval(`(async () => { const m = await import('/src/store.ts');
  m.useAppStore.setState({ lightboxUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="%234880c8"/></svg>' });
  return true; })()`);
await sleep(450);
out.scenarios.S6_open = await cdp.eval(`(() => { const ov=document.querySelector('.lightbox-overlay'); if(!ov) return {found:false};
  return { found:true, cls: ov.className, open: ov.classList.contains('open'), hasInertAttr: ov.hasAttribute('inert'), inertProp: ov.inert===true,
    imgPresent: !!ov.querySelector('img'), nominalTabbable: ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length }; })()`);
await cdp.esc();
await sleep(450);
out.scenarios.S6_afterEsc = await cdp.eval(`(() => { const ov=document.querySelector('.lightbox-overlay'); if(!ov) return {found:false};
  return { found:true, open: ov.classList.contains('open'), hasInertAttr: ov.hasAttribute('inert'), inertProp: ov.inert===true }; })()`);
out.scenarios.S6_walkAfterClose = await walk(cdp, { label: 'S6 灯箱关闭后' });

// ---------- S7: ContextMenu + ConfirmDialog ----------
out.scenarios.S7_before = await cdp.eval(`({ ctx: !!document.querySelector('.ctx-menu'), confirm: !!document.querySelector('.confirm-overlay') })`);
out.scenarios.S7_open = await cdp.eval(`(() => {
  const leaf = document.querySelector('.feed-leaf-item');
  if (!leaf) return { err: 'no feed leaf' };
  const r = leaf.getBoundingClientRect();
  leaf.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8, button: 2 }));
  return { dispatched: true }; })()`);
await sleep(400);
out.scenarios.S7_ctxOpen = await cdp.eval(`(() => { const m = document.querySelector('.ctx-menu');
  return { inDom: !!m, role: m?m.getAttribute('role'):null, items: m?m.querySelectorAll('.ctx-menu-item').length:0 }; })()`);
await cdp.esc();
await sleep(400);
out.scenarios.S7_ctxAfterEsc = await cdp.eval(`({ ctxInDom: !!document.querySelector('.ctx-menu'), confirmInDom: !!document.querySelector('.confirm-overlay') })`);

// ---------- S8: backdrop click still closes (mouse behaviour unchanged) ----------
await cdp.eval(`(async () => { const m = await import('/src/store.ts'); m.useAppStore.setState({ settingsOpen: true }); return true; })()`);
await sleep(450);
out.scenarios.S8_backdropBefore = await cdp.eval(`(() => { const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  const r = ov.getBoundingClientRect(); return { open: true, rect: [r.left, r.top, r.width, r.height],
    inner: (()=>{const c=ov.firstElementChild; const cr=c.getBoundingClientRect(); return [cr.left,cr.top,cr.width,cr.height];})() }; })()`);
out.scenarios.S8_backdropClick = await cdp.eval(`(() => { const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  const r = ov.getBoundingClientRect();
  ov.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.top + 6 }));
  return true; })()`);
await sleep(450);
out.scenarios.S8_afterBackdropClick = await cdp.eval(`({ anyOpen: Array.from(document.querySelectorAll('.modal-overlay')).some(e=>e.classList.contains('open')) })`);

out.finishedAt = new Date().toISOString();
writeFileSync(process.env.OUT_FILE, JSON.stringify(out, null, 1));
const s = out.scenarios;
console.log('S1 closed walk      :', s.S1_walk.total, 'inOverlay', s.S1_walk.inOverlayCount, 'invisible', s.S1_walk.invisibleCount, s.S1_walk.terminated);
console.log('S2 ablated walk     :', s.S2_walkAblated.total, 'inOverlay', s.S2_walkAblated.inOverlayCount, 'invisible', s.S2_walkAblated.invisibleCount, s.S2_walkAblated.terminated);
console.log('S2 restored walk    :', s.S2_walkRestored.total, 'inOverlay', s.S2_walkRestored.inOverlayCount, s.S2_walkRestored.terminated);
console.log('S3 settings-open    :', s.S3_walk.total, 'inOverlay', s.S3_walk.inOverlayCount, 'fvInOverlay', s.S3_walk.focusVisibleInOverlay, s.S3_walk.terminated);
console.log('S4 walk after Esc   :', s.S4_walkAfterClose.total, 'inOverlay', s.S4_walkAfterClose.inOverlayCount, s.S4_walkAfterClose.terminated);
console.log('S5 palette open/close:', s.S5_walkOpen.inOverlayCount, '/', s.S5_walkAfterClose.inOverlayCount);
console.log('S6 lightbox close    :', s.S6_walkAfterClose.inOverlayCount);
console.log('S7 ctx               :', JSON.stringify(s.S7_ctxOpen), JSON.stringify(s.S7_ctxAfterEsc));
console.log('S8 backdrop click    :', JSON.stringify(s.S8_afterBackdropClick));
console.log('AX closed/open       :', JSON.stringify(s.S1_axNamesClosed), JSON.stringify(s.S3_axNamesOpen));
process.exit(0);
