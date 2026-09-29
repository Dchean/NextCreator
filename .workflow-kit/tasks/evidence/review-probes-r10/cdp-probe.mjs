// Read-only CDP probe against the live FluxReader WebView2 page.
// Uses only Runtime.evaluate + Input.dispatchKeyEvent (renderer-internal; no OS input injection).
const listRes = await fetch('http://127.0.0.1:9222/json/list');
const targets = await listRes.json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
await new Promise((res) => ws.addEventListener('open', res));

function send(method, params = {}) {
  const myId = ++id;
  return new Promise((res) => { pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

const mode = process.argv[2] || 'inspect';

if (mode === 'inspect') {
  const out = await ev(`(() => {
    const q = (s) => Array.from(document.querySelectorAll(s));
    const info = (el) => el ? {
      tag: el.tagName, cls: el.className, role: el.getAttribute('role'),
      ti: el.getAttribute('tabindex'), label: (el.textContent||'').trim().slice(0,30)
    } : null;
    const allTab = q('[tabindex], button, input, textarea, select, a[href], [role="button"], [role="menuitem"], [role="slider"], [role="combobox"], [role="option"]');
    const visible = (el) => {
      let n = el;
      while (n && n.nodeType === 1) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        n = n.parentElement;
      }
      return true;
    };
    return {
      cardCount: q('[data-card-index]').length,
      cardsTab0: q('[data-card-index][tabindex="0"]').length,
      cardsTabMinus1: q('[data-card-index][tabindex="-1"]').length,
      ctxTargets: q('[data-ctx]').length,
      bodyText: document.body.innerText.slice(0, 200),
      closedModalTabbables: q('.modal-overlay:not(.open) button, .modal-overlay:not(.open) [tabindex="0"], .modal-overlay:not(.open) input').length,
      overlays: q('.modal-overlay').map((o) => ({ open: o.classList.contains('open'), opacity: getComputedStyle(o).opacity, pe: getComputedStyle(o).pointerEvents, inert: o.hasAttribute('inert'), ariaHidden: o.getAttribute('aria-hidden'), tabbables: o.querySelectorAll('button,[tabindex="0"],input').length })),
      miniTrack: info(document.querySelector('.player-progress-track:not(.player-full-track)')),
      fullTrack: info(document.querySelector('.player-full-track')),
      active: info(document.activeElement)
    };
  })()`);
  console.log(JSON.stringify(out, null, 2));
}

if (mode === 'tab') {
  // Focus the page body first, then dispatch real Tab key events through the renderer.
  await ev('document.body.focus(); document.activeElement && document.activeElement.blur(); void 0;');
  const stops = [];
  for (let i = 0; i < 40; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', nativeVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab', nativeVirtualKeyCode: 9 });
    const s = await ev(`(() => {
      const el = document.activeElement;
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName, cls: String(el.className).slice(0,44),
        role: el.getAttribute('role'), ti: el.getAttribute('tabindex'),
        fv: el.matches(':focus-visible'),
        outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
        label: (el.textContent||'').trim().slice(0,24),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        inClosedModal: !!el.closest('.modal-overlay:not(.open)'),
        visible: (() => { let n = el; while (n && n.nodeType===1) { const c = getComputedStyle(n); if (c.display==='none'||c.visibility==='hidden'||c.opacity==='0') return false; n = n.parentElement; } return true; })()
      };
    })()`);
    stops.push(s);
    if (i > 3 && s && s.tag === 'BODY') break;
  }
  console.log(JSON.stringify(stops, null, 1));
}

ws.close();
