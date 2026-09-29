// Probe v3: real-Tab focus ring visibility for every control inside the OPEN settings modal.
import { writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page' && /5173/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && pending.has(x.id)) { const p = pending.get(x.id); pending.delete(x.id); x.error ? p.rej(new Error(JSON.stringify(x.error))) : p.res(x.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 25000); });
const ev = async (e, ap = true) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: ap }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'err'); return r.result.value; };
const key = async (k, code, vk, mod = 0) => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mod }); };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:5173/' });
for (let i = 0; i < 80; i++) { const ok = await ev(`!!document.querySelector('#root') && document.querySelector('#root').children.length>0`).catch(() => false); if (ok) break; await sleep(250); }
await sleep(500);
await ev(`(async()=>{const [m,md]=await Promise.all([import('/src/store.ts'),import('/src/mockData.ts')]);m.useAppStore.setState({categories:md.createInitialCategories(),entries:md.createInitialEntries(),dataMode:'mock'});return true;})()`);
await sleep(400);
await ev(`(async()=>{const m=await import('/src/store.ts');m.useAppStore.setState({settingsOpen:true});return true;})()`);
await sleep(500);

const stamp = `(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  const ctrls=Array.from(ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));
  const ae=document.activeElement; const idx=ctrls.indexOf(ae);
  if(idx<0) return null;
  const r=ae.getBoundingClientRect(); const box=ae.closest('label')||ae.parentElement;
  let rr=r; if((r.width<2||r.height<2)&&box) rr=box.getBoundingClientRect();
  const cs=getComputedStyle(ae); const boxCs=box?getComputedStyle(box):null;
  return {idx, tag:ae.tagName, type:ae.type||null, cls:(ae.className||'').toString().slice(0,30),
    x:Math.max(0,Math.floor(rr.left-8)), y:Math.max(0,Math.floor(rr.top-8)),
    w:Math.ceil(rr.width+16), h:Math.ceil(rr.height+16),
    fv:ae.matches(':focus-visible'), effOpacity:(()=>{let op=1,p=ae;while(p&&p.nodeType===1){const o=parseFloat(getComputedStyle(p).opacity);if(!Number.isNaN(o))op*=o;p=p.parentElement;}return Math.round(op*100)/100;})(),
    outline:cs.outlineWidth+' '+cs.outlineStyle+' '+cs.outlineColor+' off='+cs.outlineOffset,
    boxOutline:boxCs?boxCs.outlineWidth+' '+boxCs.outlineStyle+' '+boxCs.outlineColor+' off='+boxCs.outlineOffset:null,
    boxCls:box?(box.className||'').toString().slice(0,30):null};})()`;

// real Tab walk; capture a clip at every stop that lands inside the open overlay
const shots = []; const rects = new Map();
for (let i = 1; i <= 90; i++) {
  await key('Tab', 'Tab', 9); await sleep(60);
  const s = await ev(stamp);
  if (!s) continue;
  if (rects.has(s.idx)) { shots.push({ ...s, dup: true }); break; }
  const clip = { x: s.x, y: s.y, width: s.w, height: s.h, scale: 1 };
  const img = await send('Page.captureScreenshot', { format: 'png', clip });
  rects.set(s.idx, clip);
  shots.push({ ...s, focusedPng: img.data });
}
// baseline: blur everything, modal still open, recapture same clips
await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); document.body.focus && document.body.focus(); true`);
await sleep(350);
const rows = [];
for (const s of shots) {
  if (!s.focusedPng) { rows.push({ idx: s.idx, dup: true }); continue; }
  const base = await send('Page.captureScreenshot', { format: 'png', clip: rects.get(s.idx) });
  rows.push({ idx: s.idx, tag: s.tag, type: s.type, cls: s.cls, boxCls: s.boxCls, fv: s.fv, effOpacity: s.effOpacity,
    outline: s.outline, boxOutline: s.boxOutline, w: s.w, h: s.h, ringVisible: s.focusedPng !== base.data });
}
writeFileSync(process.env.OUT_FILE, JSON.stringify(rows, null, 1));
console.log('idx tag/type          cls                  box            fv     op    size     ringVisible  outline');
for (const r of rows.sort((a, b) => a.idx - b.idx)) {
  if (r.dup) { console.log(`  ${r.idx} (walk returned to an already-visited stop)`); continue; }
  console.log(`${String(r.idx).padStart(3)} ${(r.tag + (r.type ? '[' + r.type + ']' : '')).padEnd(18)} ${String(r.cls).padEnd(20)} ${String(r.boxCls).padEnd(14)} ${String(r.fv).padEnd(6)} ${String(r.effOpacity).padEnd(5)} ${(r.w + 'x' + r.h).padEnd(8)} ${String(r.ringVisible).padEnd(12)} ${r.outline}`);
}
const vis = rows.filter((r) => !r.dup);
console.log(`\nfocus-visible=true: ${vis.filter((r) => r.fv).length}/${vis.length}; ring pixels changed: ${vis.filter((r) => r.ringVisible).length}/${vis.length}`);
process.exit(0);
