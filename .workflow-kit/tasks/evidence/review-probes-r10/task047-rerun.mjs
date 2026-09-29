// TASK-047 reviewer re-run (repair round): generation-based identity marking.
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

let GEN = 0;
async function fresh() {
  await send('Page.navigate', { url: APP });
  for (let i = 0; i < 80; i++) { const ok = await ev(`!!document.querySelector('#root') && document.querySelector('#root').children.length>0`).catch(() => false); if (ok) break; await sleep(250); }
  await sleep(500);
  await ev(`(async()=>{const [m,md]=await Promise.all([import('/src/store.ts'),import('/src/mockData.ts')]);m.useAppStore.setState({categories:md.createInitialCategories(),entries:md.createInitialEntries(),dataMode:'mock'});return true;})()`);
  await sleep(450);
}
// generation-based marking: attribute data-g047 = "g{gen}_{n}" (attribute, cleaned by attribute selector)
async function walk(label, max = 240) {
  GEN++;
  await ev(`document.querySelectorAll('[data-g047]').forEach(e=>e.removeAttribute('data-g047'));'ok'`);
  const stops = []; let term = 'max'; let bodySeen = 0;
  for (let i = 1; i <= max; i++) {
    await key('Tab', 'Tab', 9); await sleep(38);
    const info = await ev(`(()=>{const el=document.activeElement;
      if(!el||el===document.body||el===document.documentElement) return {body:true};
      const ov=el.closest('.modal-overlay'); let op=1,p=el;
      while(p&&p.nodeType===1){const o=parseFloat(getComputedStyle(p).opacity);if(!Number.isNaN(o))op*=o;p=p.parentElement;}
      return {tag:el.tagName, cls:(el.className||'').toString().slice(0,44), text:(el.textContent||'').trim().slice(0,14),
        ov:!!ov, op:Math.round(op*100)/100, fv:el.matches(':focus-visible'), mark:el.getAttribute('data-g047')};})()`);
    if (info.body) { bodySeen++; stops.push({ n: i, body: true }); continue; }
    if (info.mark) { term = 'repeat-of-' + info.mark + '-at-tab#' + i; stops.push({ n: i, ...info, repeatOf: true }); break; }
    await ev(`(()=>{const el=document.activeElement;el.setAttribute('data-g047','g${GEN}_${i}');return true;})()`);
    stops.push({ n: i, ...info, stamp: `g${GEN}_${i}` });
  }
  const distinct = stops.filter((s) => !s.body && !s.repeatOf);
  const main = distinct.filter((s) => !s.ov);
  const inOv = distinct.filter((s) => s.ov);
  const inv = distinct.filter((s) => s.op < 0.05);
  return { label, term, rawTabs: stops.length, bodyStops: bodySeen, distinctStops: distinct.length,
    mainViewCount: main.length, overlayCount: inOv.length, invisibleCount: inv.length,
    fvAll: distinct.filter((s) => s.fv).length, overlayFv: inOv.filter((s) => s.fv).length,
    overlayInvisible: inOv.filter((s) => s.op < 0.05).length,
    overlayClasses: [...new Set(inOv.map((s) => s.cls.split(' ')[0]))],
    mainOrder: main.map((s) => `${s.tag}.${s.cls.split(' ')[0]}`), stops };
}
const OVERLAYS = `Array.from(document.querySelectorAll('.modal-overlay')).map((e,i)=>({i,cls:e.className,open:e.classList.contains('open'),inert:e.hasAttribute('inert'),inertProp:e.inert===true,val:e.getAttribute('inert'),nominal:e.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length}))`;

const out = { startedAt: new Date().toISOString() };
out.ua = await ev('navigator.userAgent');
await fresh();
out.overlaysClosed = await ev(OVERLAYS);
out.closedRuns = [];
for (let k = 0; k < 3; k++) { await fresh(); out.closedRuns.push(await walk('closed#' + k)); }
await fresh();
out.ablated = await (async () => {
  out.strip = await ev(`(()=>{const els=Array.from(document.querySelectorAll('.modal-overlay'));els.forEach(e=>{e.removeAttribute('inert');e.inert=false;});return {stripped:els.length,still:els.filter(e=>e.hasAttribute('inert')).length};})()`);
  const w = await walk('ablated');
  return w;
})();
await fresh();
out.restored = await walk('restored(after reload)');
await fresh();
out.palette = await (async () => { await key('k', 'KeyK', 75, 2); await sleep(450);
  const open = await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));return ov?{cls:ov.className,inert:ov.hasAttribute('inert'),nominal:ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length}:null;})()`);
  const w = await walk('palette-open'); await key('Escape', 'Escape', 27); await sleep(450);
  const after = await walk('palette-closed'); return { open, walkOpen: w, walkClosed: after }; })();
out.finishedAt = new Date().toISOString();
writeFileSync(process.env.OUT_FILE, JSON.stringify(out, null, 1));
for (const r of [...out.closedRuns, out.ablated, out.restored, out.palette.walkOpen, out.palette.walkClosed]) {
  console.log(`${r.label.padEnd(22)} main=${String(r.mainViewCount).padStart(3)} overlay=${String(r.overlayCount).padStart(3)} invisible=${String(r.invisibleCount).padStart(3)} rawTabs=${String(r.rawTabs).padStart(3)} body=${r.bodyStops} overlayFv=${r.overlayFv}/${r.overlayCount} ${r.term}`);
}
console.log('overlays closed:', out.overlaysClosed.map((o) => `#${o.i}:open=${o.open},inert=${o.inert},nominal=${o.nominal}`).join(' | '));
console.log('palette open:', JSON.stringify(out.palette.open));
process.exit(0);
