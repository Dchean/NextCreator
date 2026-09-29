// Probe: what are the opacity-0 stops inside the OPEN settings modal, and does focusing them change pixels?
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
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:5173/' });
for (let i = 0; i < 80; i++) { const ok = await ev(`!!document.querySelector('#root') && document.querySelector('#root').children.length>0`).catch(() => false); if (ok) break; await sleep(250); }
await sleep(500);
await ev(`(async()=>{const [m,md]=await Promise.all([import('/src/store.ts'),import('/src/mockData.ts')]);m.useAppStore.setState({categories:md.createInitialCategories(),entries:md.createInitialEntries(),dataMode:'mock'});return true;})()`);
await sleep(400);
await ev(`(async()=>{const m=await import('/src/store.ts');m.useAppStore.setState({settingsOpen:true});return true;})()`);
await sleep(500);

const detail = await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  const ctrls=Array.from(ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));
  return ctrls.map((el,i)=>{let op=1,p=el;while(p&&p.nodeType===1){const o=parseFloat(getComputedStyle(p).opacity);if(!Number.isNaN(o))op*=o;p=p.parentElement;}
    const cs=getComputedStyle(el);const r=el.getBoundingClientRect();
    return {i,tag:el.tagName,type:el.type||null,cls:(el.className||'').toString().slice(0,40),parentTag:el.parentElement?el.parentElement.tagName:null,
      parentCls:el.parentElement?(el.parentElement.className||'').toString().slice(0,44):null,op:Math.round(op*100)/100,
      rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],
      outline:cs.outlineWidth+' '+cs.outlineStyle+' '+cs.outlineColor+' off='+cs.outlineOffset,vis:cs.visibility,disp:cs.display};});})()`);
writeFileSync(process.env.OUT_FILE, JSON.stringify({ detail }, null, 1));
for (const d of detail) console.log(`#${String(d.i).padStart(2)} ${d.tag}${d.type ? '[' + d.type + ']' : ''} .${d.cls} op=${d.op} rect=${d.rect.join(',')} parent=${d.parentTag}.${d.parentCls} outline=${d.outline} disp=${d.disp} vis=${d.vis}`);

// pixel-change test for the opacity-0 controls: focus -> screenshot(clip) vs blur -> screenshot(clip)
const zero = detail.filter((d) => d.op < 0.05 && d.rect[2] > 0 && d.rect[3] > 0);
console.log('\nzero-opacity controls with non-zero rect:', zero.length);
const results = [];
for (const d of zero.slice(0, 12)) {
  await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); true`);
  await sleep(150);
  const clip = { x: d.rect[0], y: d.rect[1], width: d.rect[2], height: d.rect[3], scale: 1 };
  const before = await send('Page.captureScreenshot', { format: 'png', clip });
  await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
    const ctrls=Array.from(ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));
    ctrls[${d.i}].focus(); return true;})()`);
  await sleep(220);
  const after = await send('Page.captureScreenshot', { format: 'png', clip });
  const fv = await ev(`document.activeElement.matches(':focus-visible')`);
  const isActive = await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
    const ctrls=Array.from(ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));return document.activeElement===ctrls[${d.i}];})()`);
  results.push({ i: d.i, tag: d.tag, type: d.type, cls: d.cls, parentCls: d.parentCls, focusLanded: isActive, focusVisible: fv,
    clipPixelsChanged: before.data !== after.data, beforeLen: before.data.length, afterLen: after.data.length });
}
// also a control known to be visible (e.g. the nav item) as a positive control
const navIdx = detail.findIndex((d) => (d.cls || '').includes('settings-nav-item'));
if (navIdx >= 0) {
  const d = detail[navIdx];
  await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); true`); await sleep(150);
  const clip = { x: d.rect[0], y: d.rect[1], width: d.rect[2], height: d.rect[3], scale: 1 };
  const b = await send('Page.captureScreenshot', { format: 'png', clip });
  await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
    const ctrls=Array.from(ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));ctrls[${navIdx}].focus();return true;})()`);
  await sleep(220);
  const a = await send('Page.captureScreenshot', { format: 'png', clip });
  results.push({ i: navIdx, tag: d.tag, cls: d.cls, positiveControl: true, clipPixelsChanged: b.data !== a.data });
}
writeFileSync(process.env.OUT_FILE, JSON.stringify({ detail, results }, null, 1));
console.log('\n=== pixel-change on focus ===');
for (const r of results) console.log(JSON.stringify(r));
process.exit(0);
