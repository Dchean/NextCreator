// TASK-047 reviewer re-run part 2: open state + remaining acceptance items (same round).
import { writeFileSync } from 'node:fs';
const APP = 'http://localhost:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page' && /5173/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && pending.has(x.id)) { const p = pending.get(x.id); pending.delete(x.id); x.error ? p.rej(new Error(JSON.stringify(x.error))) : p.res(x.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 25000); });
const ev = async (e, ap = true) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: ap }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err'); return r.result.value; };
const key = async (k, code, vk, mod = 0) => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod }); };
await send('Runtime.enable'); await send('Page.enable');
let GEN = 100;
async function fresh() {
  await send('Page.navigate', { url: APP });
  for (let i = 0; i < 80; i++) { const ok = await ev(`!!document.querySelector('#root') && document.querySelector('#root').children.length>0`).catch(() => false); if (ok) break; await sleep(250); }
  await sleep(500);
  await ev(`(async()=>{const [m,md]=await Promise.all([import('/src/store.ts'),import('/src/mockData.ts')]);m.useAppStore.setState({categories:md.createInitialCategories(),entries:md.createInitialEntries(),dataMode:'mock'});return true;})()`);
  await sleep(450);
}
async function walk(label, max = 240) {
  GEN++;
  await ev(`document.querySelectorAll('[data-g047]').forEach(e=>e.removeAttribute('data-g047'));'ok'`);
  const stops = []; let term = 'max'; let body = 0;
  for (let i = 1; i <= max; i++) {
    await key('Tab', 'Tab', 9); await sleep(38);
    const info = await ev(`(()=>{const el=document.activeElement;
      if(!el||el===document.body||el===document.documentElement) return {body:true};
      const ov=el.closest('.modal-overlay'); let op=1,p=el;
      while(p&&p.nodeType===1){const o=parseFloat(getComputedStyle(p).opacity);if(!Number.isNaN(o))op*=o;p=p.parentElement;}
      const cs=getComputedStyle(el);
      return {tag:el.tagName,cls:(el.className||'').toString().slice(0,40),text:(el.textContent||'').trim().slice(0,12),
        ov:!!ov,op:Math.round(op*100)/100,fv:el.matches(':focus-visible'),mark:el.getAttribute('data-g047'),
        outline:cs.outlineWidth+' '+cs.outlineStyle+' '+cs.outlineColor+' off='+cs.outlineOffset};})()`);
    if (info.body) { body++; stops.push({ n: i, body: true }); continue; }
    if (info.mark) { term = 'repeat-of-' + info.mark + '-at-tab#' + i; stops.push({ n: i, ...info, repeatOf: true }); break; }
    await ev(`(()=>{const el=document.activeElement;el.setAttribute('data-g047','g${GEN}_${i}');return true;})()`);
    stops.push({ n: i, ...info });
  }
  const d = stops.filter((s) => !s.body && !s.repeatOf);
  const main = d.filter((s) => !s.ov), inOv = d.filter((s) => s.ov);
  return { label, term, rawTabs: stops.length, bodyStops: body, mainView: main.length, overlay: inOv.length,
    invisible: d.filter((s) => s.op < 0.05).length, overlayInvisible: inOv.filter((s) => s.op < 0.05).length,
    overlayFv: inOv.filter((s) => s.fv).length, firstOverlayTabIndex: inOv.length ? inOv[0].n : null,
    mainBeforeOverlay: inOv.length ? main.filter((s) => s.n < inOv[0].n).length : null,
    overlayStops: inOv.map((s) => ({ n: s.n, tag: s.tag, cls: s.cls.split(' ')[0], fv: s.fv, op: s.op, outline: s.outline, text: s.text })) };
}
const out = {};
// settings OPEN
await fresh();
await ev(`(async()=>{const m=await import('/src/store.ts');m.useAppStore.setState({settingsOpen:true});return true;})()`);
await sleep(500);
out.settingsOpenState = await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  return ov?{cls:ov.className,hasInertAttr:ov.hasAttribute('inert'),inertProp:ov.inert===true,nominal:ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length,navItems:ov.querySelectorAll('.settings-nav-item').length}:null;})()`);
out.settingsWalk = await walk('settings-open');
// focus inside then Esc
await fresh();
await ev(`(async()=>{const m=await import('/src/store.ts');m.useAppStore.setState({settingsOpen:true});return true;})()`);
await sleep(450);
out.focusInsideBeforeEsc = await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));const c=ov.querySelector('.settings-nav-item');c.focus();const ae=document.activeElement;return {tag:ae.tagName,cls:ae.className.toString().slice(0,40),fv:ae.matches(':focus-visible'),outline:getComputedStyle(ae).outlineWidth+' '+getComputedStyle(ae).outlineColor,openInert:ov.hasAttribute('inert')};})()`);
await key('Escape', 'Escape', 27); await sleep(500);
out.afterEsc = await ev(`(()=>{const ae=document.activeElement;const ovs=Array.from(document.querySelectorAll('.modal-overlay'));
  return {anyOpen:ovs.some(e=>e.classList.contains('open')),allClosedInert:ovs.every(e=>e.classList.contains('open')||e.hasAttribute('inert')),
    active:{tag:ae?ae.tagName:null,cls:ae&&ae.className?ae.className.toString().slice(0,40):null,inOverlay:!!(ae&&ae.closest&&ae.closest('.modal-overlay')),inertAncestor:!!(ae&&ae.closest&&ae.closest('[inert]'))}};})()`);
out.afterEscWalk = await walk('after-esc');
// lightbox
await fresh();
await ev(`(async()=>{const m=await import('/src/store.ts');m.useAppStore.setState({lightboxUrl:'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="%234880c8"/></svg>'});return true;})()`);
await sleep(450);
out.lightboxOpen = await ev(`(()=>{const ov=document.querySelector('.lightbox-overlay');return {open:ov.classList.contains('open'),hasInertAttr:ov.hasAttribute('inert'),imgPresent:!!ov.querySelector('img'),nominal:ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length};})()`);
await key('Escape', 'Escape', 27); await sleep(450);
out.lightboxAfterEsc = await ev(`(()=>{const ov=document.querySelector('.lightbox-overlay');return {open:ov.classList.contains('open'),hasInertAttr:ov.hasAttribute('inert'),inertProp:ov.inert===true};})()`);
out.lightboxWalk = await walk('lightbox-closed');
// ctx menu / confirm
await fresh();
out.ctxBefore = await ev(`({ctx:!!document.querySelector('.ctx-menu'),confirm:!!document.querySelector('.confirm-overlay')})`);
await ev(`(()=>{const leaf=document.querySelector('.feed-leaf-item');const r=leaf.getBoundingClientRect();leaf.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+8,button:2}));return true;})()`);
await sleep(450);
out.ctxOpen = await ev(`(()=>{const m=document.querySelector('.ctx-menu');return {inDom:!!m,role:m?m.getAttribute('role'):null,items:m?m.querySelectorAll('.ctx-menu-item').length:0};})()`);
await key('Escape', 'Escape', 27); await sleep(450);
out.ctxAfterEsc = await ev(`({ctxInDom:!!document.querySelector('.ctx-menu'),confirmInDom:!!document.querySelector('.confirm-overlay')})`);
// backdrop click
await ev(`(async()=>{const m=await import('/src/store.ts');m.useAppStore.setState({settingsOpen:true});return true;})()`);
await sleep(450);
await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));const r=ov.getBoundingClientRect();ov.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:r.left+6,clientY:r.top+6}));return true;})()`);
await sleep(450);
out.backdropClickClosed = await ev(`({anyOpen:Array.from(document.querySelectorAll('.modal-overlay')).some(e=>e.classList.contains('open'))})`);
writeFileSync(process.env.OUT_FILE, JSON.stringify(out, null, 1));
console.log('settings open state:', JSON.stringify(out.settingsOpenState));
console.log('settings walk:', out.settingsWalk.mainView, 'main +', out.settingsWalk.overlay, 'overlay = raw', out.settingsWalk.rawTabs, '| overlayFv', out.settingsWalk.overlayFv + '/' + out.settingsWalk.overlay, '| mainBeforeOverlay', out.settingsWalk.mainBeforeOverlay, '| firstOverlayTab', out.settingsWalk.firstOverlayTabIndex, '| invisible', out.settingsWalk.invisible);
console.log('focus inside:', JSON.stringify(out.focusInsideBeforeEsc));
console.log('after Esc:', JSON.stringify(out.afterEsc), '| walk', out.afterEscWalk.mainView, '/', out.afterEscWalk.overlay);
console.log('lightbox:', JSON.stringify(out.lightboxOpen), '->', JSON.stringify(out.lightboxAfterEsc), '| walk overlay', out.lightboxWalk.overlay);
console.log('ctx:', JSON.stringify(out.ctxBefore), JSON.stringify(out.ctxOpen), JSON.stringify(out.ctxAfterEsc), '| backdrop', JSON.stringify(out.backdropClickClosed));
process.exit(0);
