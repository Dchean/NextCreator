// Probe v2: does focusing each control class actually change rendered pixels (clip expanded to include outline)?
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

// Walk the overlay controls by real Tab and test each: does focusing change pixels in [element rect ∪ clip union]?
const info = await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  return { nominal: ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length };})()`);
console.log('nominal overlay controls:', info.nominal);

// for a given index: rect = union of element rect and its closest label/switch wrapper, expanded by 8px
const rectExpr = (i) => `(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
  const c=Array.from(ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'))[${i}];
  let r=c.getBoundingClientRect(); const box=c.closest('label')||c.parentElement;
  if(box && (r.width<2||r.height<2)) r=box.getBoundingClientRect();
  return {x:Math.max(0,Math.floor(r.left-8)),y:Math.max(0,Math.floor(r.top-8)),width:Math.ceil(r.width+16),height:Math.ceil(r.height+16),
    tag:c.tagName,type:c.type||null,cls:(c.className||'').toString().slice(0,30),w:Math.round(r.width),h:Math.round(r.height)};})()`;

const out = [];
for (let i = 0; i < info.nominal; i++) {
  await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); true`); await sleep(140);
  const r = await ev(rectExpr(i));
  const before = await send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } });
  await ev(`(()=>{const ov=Array.from(document.querySelectorAll('.modal-overlay')).find(e=>e.classList.contains('open'));
    const c=Array.from(ov.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'))[${i}];c.focus();return true;})()`);
  await sleep(200);
  const after = await send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } });
  const st = await ev(`(()=>{const ae=document.activeElement;const cs=getComputedStyle(ae);
    let op=1,p=ae;while(p&&p.nodeType===1){const o=parseFloat(getComputedStyle(p).opacity);if(!Number.isNaN(o))op*=o;p=p.parentElement;}
    const box=ae.closest('label');const boxCs=box?getComputedStyle(box):null;
    return {fv:ae.matches(':focus-visible'),op:Math.round(op*100)/100,
      outline:cs.outlineWidth+' '+cs.outlineStyle+' '+cs.outlineColor+' off='+cs.outlineOffset,
      boxOutline:boxCs?boxCs.outlineWidth+' '+boxCs.outlineStyle+' '+boxCs.outlineColor+' off='+boxCs.outlineOffset:null};})()`);
  out.push({ i, ...r, ...st, pixelsChanged: before.data !== after.data });
}
writeFileSync(process.env.OUT_FILE, JSON.stringify(out, null, 1));
console.log('idx tag/type        cls                    size     op   fv    outline                                    boxOutline                                 changed');
for (const o of out) console.log(`${String(o.i).padStart(3)} ${(o.tag + (o.type ? '[' + o.type + ']' : '')).padEnd(16)} ${String(o.cls).padEnd(22)} ${(o.w + 'x' + o.h).padEnd(8)} ${String(o.op).padEnd(4)} ${String(o.fv).padEnd(5)} ${String(o.outline).padEnd(42)} ${String(o.boxOutline).padEnd(42)} ${o.pixelsChanged}`);
process.exit(0);
