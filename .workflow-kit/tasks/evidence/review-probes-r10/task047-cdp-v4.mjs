// TASK-047 reviewer driver v4 — failure paths.
import { writeFileSync } from 'node:fs';
const BASE = 'http://127.0.0.1:9222';
const APP = 'http://localhost:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`${BASE}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /5173/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && pending.has(x.id)) { const p = pending.get(x.id); pending.delete(x.id); x.error ? p.rej(new Error(JSON.stringify(x.error))) : p.res(x.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 20000); });
const ev = async (e, awaitPromise = true) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err'); return r.result.value; };
const key = async (k, code, vk, mod = 0) => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod }); };
await send('Runtime.enable'); await send('Page.enable');

async function fresh() {
  await send('Page.navigate', { url: APP });
  for (let i = 0; i < 80; i++) { const ok = await ev(`!!document.querySelector('#root') && document.querySelector('#root').children.length>0`).catch(() => false); if (ok) break; await sleep(250); }
  await sleep(450);
  await ev(`(async()=>{const [m,md]=await Promise.all([import('/src/store.ts'),import('/src/mockData.ts')]);m.useAppStore.setState({categories:md.createInitialCategories(),entries:md.createInitialEntries(),dataMode:'mock'});return true;})()`);
  await sleep(400);
}
const OVERLAYSTATE = `Array.from(document.querySelectorAll('.modal-overlay')).map(e=>({open:e.classList.contains('open'),inert:e.hasAttribute('inert')}))`;
const walkOv = async (max = 240) => {
  await ev(`document.querySelectorAll('[data-rev047]').forEach(e=>e.removeAttribute('data-rev047'));'ok'`);
  let inOv = 0, total = 0, term = 'max';
  for (let i = 1; i <= max; i++) {
    await key('Tab', 'Tab', 9); await sleep(35);
    const info = await ev(`(()=>{const el=document.activeElement;if(!el||el===document.body)return{body:true};const ov=el.closest('.modal-overlay');let op=1,p=el;while(p&&p.nodeType===1){const o=parseFloat(getComputedStyle(p).opacity);if(!Number.isNaN(o))op*=o;p=p.parentElement;}return{ov:!!ov,op:Math.round(op*100)/100,mark:el.getAttribute('data-rev047'),cls:(el.className||'').toString().slice(0,40)};})()`);
    total++; if (info.body) continue;
    if (info.ov) inOv++;
    if (info.mark) { term = 'repeat@' + info.mark + '@' + i; break; }
    await ev(`(()=>{const el=document.activeElement;if(el)el.setAttribute('data-rev047',String(${i}));return true;})()`);
  }
  return { total, inOv, term };
};

const out = {};
// T1: rapid open/close x6 (programmatic, no waits) then closed-state invariants
await fresh();
out.T1 = await ev(`(async () => {
  const m = await import('/src/store.ts');
  for (let i = 0; i < 6; i++) { m.useAppStore.setState({ settingsOpen: true }); m.useAppStore.setState({ settingsOpen: false }); }
  return { settingsOpen: !!m.useAppStore.getState().settingsOpen };
})()`);
await sleep(500);
out.T1_overlays = await ev(OVERLAYSTATE);
out.T1_walk = await walkOv();

// T2: focus INSIDE open modal, then close programmatically (not Esc)
await ev(`(async()=>{const m=await import('/src/store.ts');m.useAppStore.setState({settingsOpen:true});return true;})()`);
await sleep(450);
out.T2_focusInside = await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));const c=ov.querySelector('.settings-nav-item');c.focus();const ae=document.activeElement;return{tag:ae.tagName,cls:ae.className.toString().slice(0,40),fv:ae.matches(':focus-visible'),inert:ov.hasAttribute('inert')};})()`);
out.T2_closedProgrammatically = await ev(`(async()=>{const m=await import('/src/store.ts');m.useAppStore.setState({settingsOpen:false});return true;})()`);
await sleep(500);
out.T2_afterProgrammaticClose = await ev(`(()=>{const ae=document.activeElement;const ovs=Array.from(document.querySelectorAll('.modal-overlay'));
  return { activeTag: ae?ae.tagName:null, activeCls: ae&&ae.className?ae.className.toString().slice(0,40):null,
    inOverlay: !!(ae&&ae.closest&&ae.closest('.modal-overlay')), inertAncestor: !!(ae&&ae.closest&&ae.closest('[inert]')),
    allClosedInert: ovs.every(e=>e.classList.contains('open')||e.hasAttribute('inert')) };})()`);
out.T2_walk = await walkOv();

// T3: stacked overlays — settings open + command palette on top; Esc closes top only
await ev(`(async()=>{const m=await import('/src/store.ts');m.useAppStore.setState({settingsOpen:true});return true;})()`);
await sleep(450);
await key('k', 'KeyK', 75, 2);
await sleep(500);
out.T3_bothOpen = await ev(`Array.from(document.querySelectorAll('.modal-overlay')).map((e,i)=>({i,open:e.classList.contains('open'),inert:e.hasAttribute('inert')})).filter(x=>x.open)`);
await key('Escape', 'Escape', 27);
await sleep(500);
out.T3_afterEsc = await ev(`(()=>{const ovs=Array.from(document.querySelectorAll('.modal-overlay'));
  return { openOnes: ovs.map((e,i)=>({i,open:e.classList.contains('open'),inert:e.hasAttribute('inert')})).filter(x=>x.open),
    closedAllInert: ovs.every(e=>e.classList.contains('open')||e.hasAttribute('inert')) };})()`);
await key('Escape', 'Escape', 27);
await sleep(500);
out.T3_afterSecondEsc = await ev(`(()=>{const ovs=Array.from(document.querySelectorAll('.modal-overlay'));
  return { anyOpen: ovs.some(e=>e.classList.contains('open')), allClosedInert: ovs.every(e=>e.classList.contains('open')||e.hasAttribute('inert')) };})()`);
out.T3_walk = await walkOv();

// T4: script-driven focus attempt INTO a closed overlay (focus() must fail per inert semantics)
out.T4 = await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay'))[0];const c=ov.querySelector('.settings-nav-item');
  c.focus(); const ae=document.activeElement;
  const q=ov.querySelector('input,button');
  return { tried: c.tagName+'.'+(c.className||'').toString().split(' ')[0], landedOn: ae?ae.tagName+'.'+(ae.className||'').toString().slice(0,30):null,
    stillInOverlay: !!(ae&&ae.closest&&ae.closest('.modal-overlay')) };})()`);

writeFileSync(process.env.OUT_FILE, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(0);
