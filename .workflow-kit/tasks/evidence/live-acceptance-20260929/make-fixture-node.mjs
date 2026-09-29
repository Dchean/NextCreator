/**
 * Fixture setup: create a fresh imageGeneratorNode on the canvas by invoking the
 * app's OWN drop handler with a real DataTransfer (the same payload the sidebar's
 * onDragStart writes at Sidebar.tsx:425 / FlowCanvas.tsx:339-340).
 *
 * This is test-fixture creation, not the behaviour under test: all assertions
 * later use REAL CDP mouse input.
 */
const NODE_TYPE = process.argv[2] || "imageGeneratorNode";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); setTimeout(() => rej(new Error("timeout")), 8000); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
const evalJs = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 500) }; return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = await evalJs("document.querySelectorAll('.react-flow__node').length");

// Read the default data the sidebar would supply for this node type, then drop it.
const result = await evalJs(`(() => {
  const pane = document.querySelector('.react-flow__pane') || document.querySelector('.react-flow');
  if (!pane) return { err: 'no flow pane' };
  const rect = pane.getBoundingClientRect();
  const dt = new DataTransfer();
  dt.setData('application/reactflow/type', ${JSON.stringify(NODE_TYPE)});
  dt.setData('application/reactflow/data', JSON.stringify({}));
  const x = rect.x + rect.width * 0.45;
  const y = rect.y + rect.height * 0.55;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt };
  pane.dispatchEvent(new DragEvent('dragover', base));
  pane.dispatchEvent(new DragEvent('drop', base));
  return { ok: true, x: Math.round(x), y: Math.round(y) };
})()`);
console.log("drop attempt:", JSON.stringify(result));
await sleep(2000);

const after = await evalJs("document.querySelectorAll('.react-flow__node').length");
const classes = await evalJs("[...document.querySelectorAll('.react-flow__node')].map(e=>(e.getAttribute('class')||'').replace('react-flow__node ','').split(' ')[0])");
console.log(`nodes ${before} -> ${after}`);
console.log("classes:", JSON.stringify(classes));
ws.close();
process.exit(after > before ? 0 : 3);
