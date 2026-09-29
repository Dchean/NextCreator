const listRes = await fetch('http://127.0.0.1:9222/json/list');
const targets = await listRes.json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
function send(method, params = {}) { const my = ++id; return new Promise((res) => { pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); }); }
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; }

console.log('dataMode / store snapshot:', JSON.stringify(await ev(`(() => {
  const s = window.__FLUX_STORE__ ? window.__FLUX_STORE__.getState() : null;
  return { hasGlobal: !!window.__FLUX_STORE__, dataMode: s && s.dataMode, entries: s && (s.entries||[]).length, feeds: s && (s.feeds||[]).length, layout: s && s.activeContentLayout };
})()`)));

console.log('cards on screen:', JSON.stringify(await ev(`Array.from(document.querySelectorAll('[data-card-index]')).map(e => ({i:e.getAttribute('data-card-index'), ti:e.getAttribute('tabindex'), tag:e.tagName, cls:String(e.className).slice(0,30)}))`)));

// Real Tab traversal through the renderer (no OS input layer).
await ev(`document.activeElement && document.activeElement.blur(); void 0;`);
const stops = [];
for (let i = 0; i < 45; i++) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', nativeVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', nativeVirtualKeyCode: 9 });
  const s = await ev(`(() => {
    const el = document.activeElement; if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, cls: String(el.className).slice(0,40), role: el.getAttribute('role'),
      ti: el.getAttribute('tabindex'), fv: el.matches(':focus-visible'),
      outline: cs.outlineStyle+' '+cs.outlineWidth, label:(el.getAttribute('title')||el.textContent||'').trim().slice(0,26),
      rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
      inClosedModal: !!el.closest('.modal-overlay:not(.open)') };
  })()`);
  stops.push(s);
  if (i > 2 && s && s.tag === 'BODY') break;
  if (i > 30 && stops.slice(-6).every(x => x && x.tag === 'BODY')) break;
}
console.log('=== TAB STOPS ===');
stops.forEach((s, i) => console.log(String(i+1).padStart(2) + ' ' + JSON.stringify(s)));
ws.close();
