const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r));
function send(method, params = {}) { const my = ++id; return new Promise((res) => { pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); }); }
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; }
async function key(k, vk) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: vk, code: k, key: k, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, code: k, key: k, nativeVirtualKeyCode: vk });
}
const state = () => ev(`(() => {
  const cards = Array.from(document.querySelectorAll('[data-card-index]'));
  const t0 = cards.filter(c => c.getAttribute('tabindex') === '0').map(c => c.getAttribute('data-card-index'));
  const a = document.activeElement;
  return {
    tabbableCards: t0,
    cardCount: cards.length,
    active: a ? { tag: a.tagName, idx: a.getAttribute('data-card-index'), role: a.getAttribute('role'), ti: a.getAttribute('tabindex'), fv: a.matches(':focus-visible'), outline: getComputedStyle(a).outlineStyle + ' ' + getComputedStyle(a).outlineWidth } : null
  };
})()`);

console.log('BEFORE:', JSON.stringify(await state()));

// Focus the single tabbable card directly (element is already known tabbable).
await ev(`(() => { const c = document.querySelector('[data-card-index][tabindex="0"]'); if (c) c.focus(); return !!c; })()`);
await new Promise(r => setTimeout(r, 120));
console.log('AFTER .focus() on tabbable card:', JSON.stringify(await state()));

// Real ArrowRight through the renderer -> should trigger the roving handler
await key('ArrowRight', 39);
await new Promise(r => setTimeout(r, 300));
console.log('AFTER ArrowRight:', JSON.stringify(await state()));

await key('ArrowRight', 39);
await new Promise(r => setTimeout(r, 300));
console.log('AFTER ArrowRight x2:', JSON.stringify(await state()));

await key('ArrowLeft', 37);
await new Promise(r => setTimeout(r, 300));
console.log('AFTER ArrowLeft    :', JSON.stringify(await state()));

// Does a focusable slider (mini track) respond to arrow keys at all?
console.log('mini track has React onKeyDown prop?', JSON.stringify(await ev(`(() => {
  const el = document.querySelector('.player-progress-track:not(.player-full-track)');
  if (!el) return 'absent';
  const k = Object.keys(el).find(x => x.startsWith('__reactProps'));
  const p = k ? el[k] : null;
  return { found: !!p, onKeyDown: !!(p && p.onKeyDown), role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex') };
})()`)));
ws.close();
