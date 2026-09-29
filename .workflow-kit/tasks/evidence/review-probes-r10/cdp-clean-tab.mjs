const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
function send(m, p = {}) { const my = ++id; return new Promise((res) => { pending.set(my, res); ws.send(JSON.stringify({ id: my, method: m, params: p })); }); }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; }

// Clean start: put focus on the FIRST tabbable element in the document, then Tab forward only.
const first = await ev(`(() => {
  const f = document.querySelector('.immersive-win-controls .win-btn');
  if (f) f.focus();
  return f ? f.getAttribute('title') : null;
})()`);
console.log('start focus =', first);

const rows = [];
for (let i = 0; i < 70; i++) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', nativeVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', nativeVirtualKeyCode: 9 });
  const s = await ev(`(() => {
    const el = document.activeElement; if (!el) return null;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    return { t: el.tagName, c: String(el.className).slice(0,34), role: el.getAttribute('role'),
      ti: el.getAttribute('tabindex'), fv: el.matches(':focus-visible'),
      lb: (el.getAttribute('title') || el.textContent || '').trim().replace(/\\s+/g,' ').slice(0,22),
      z: Math.round(r.width)+'x'+Math.round(r.height),
      closed: !!el.closest('.modal-overlay:not(.open)'),
      inSettings: !!el.closest('.settings-modal') };
  })()`);
  rows.push(s);
  if (i > 2 && s && s.t === 'BODY') break;
}
console.log('=== CLEAN FORWARD TAB TRAVERSAL (from first win-btn) ===');
rows.forEach((s, i) => console.log(String(i + 1).padStart(2), JSON.stringify(s)));
const closedCount = rows.filter(r => r && r.closed).length;
console.log('TOTAL STOPS =', rows.length, ' IN CLOSED MODAL =', closedCount, ' VISIBLE =', rows.length - closedCount);
ws.close();
