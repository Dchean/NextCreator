// 用 CDP 的 Input.dispatchKeyEvent 做「真实键盘」Tab 遍历（会设置 :focus-visible），
// 逐停靠点读计算样式并截图。这修掉了上一轮用 el.focus() 造成的 fv=false 假象。
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';

const PORT = 9222;
const EV = 'D:\\fluxreader\\.workflow-kit\\tasks\\evidence\\';
const httpGet = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
});
class CDP {
  constructor(u) { this.url = new URL(u); this.id = 0; this.pending = new Map(); this.buf = Buffer.alloc(0); }
  connect() { return new Promise((resolve, reject) => {
    this.sock = net.connect(Number(this.url.port), this.url.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock.write(`GET ${this.url.pathname} HTTP/1.1\r\nHost: ${this.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let hs = false;
    this.sock.on('data', (ch) => { if (!hs) { const s = ch.toString('latin1'); const i = s.indexOf('\r\n\r\n'); if (i === -1) return; hs = true;
        if (!s.startsWith('HTTP/1.1 101')) return reject(new Error(s.split('\r\n')[0]));
        const rest = ch.subarray(i + 4); if (rest.length) this._f(rest); resolve(); return; } this._f(ch); });
    this.sock.on('error', reject);
  }); }
  _f(ch) { this.buf = Buffer.concat([this.buf, ch]);
    for (;;) { const b = this.buf; if (b.length < 2) return; const op = b[0] & 0x0f; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return; const pl = b.subarray(off, off + len); this.buf = b.subarray(off + len);
      if (op === 1) { const m = JSON.parse(pl.toString('utf8')); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }
      else if (op === 8) { this.sock.end(); return; } } }
  send(method, params = {}) { const id = ++this.id; const pl = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    const mask = crypto.randomBytes(4); let h; const L = pl.length;
    if (L < 126) { h = Buffer.alloc(6); h[1] = 0x80 | L; } else if (L < 65536) { h = Buffer.alloc(8); h[1] = 0x80 | 126; h.writeUInt16BE(L, 2); } else { h = Buffer.alloc(14); h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(L), 2); }
    h[0] = 0x81; mask.copy(h, h.length - 4); const m = Buffer.alloc(L); for (let i = 0; i < L; i++) m[i] = pl[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([h, m])); return new Promise(r => this.pending.set(id, r)); }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; }
  async key(key, code, vk, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  }
  async shot(path) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); if (!r.result?.data) return false;
    fs.writeFileSync(path, Buffer.from(r.result.data, 'base64')); return true; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const HASH = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

const INFO = `(()=>{const el=document.activeElement;if(!el)return null;const s=getComputedStyle(el);
  const cls=(typeof el.className==='string'?el.className:(el.getAttribute('class')||''));
  return {tag:el.tagName,cls:cls.slice(0,44),role:el.getAttribute('role'),type:el.getAttribute('type'),
    ti:el.tabIndex,fv:el.matches(':focus-visible'),ol:s.outlineStyle,olw:s.outlineWidth,olc:s.outlineColor,
    label:(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,24)};})()`;

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const page = list.find(t => t.type === 'page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await sleep(400);
  console.log('CDP connected\n');

  for (let i = 0; i < 5; i++) { await cdp.key('Escape', 'Escape', 27); await sleep(260); }
  await sleep(500);
  await cdp.eval('window.focus(); document.body.focus?.(); true');
  await sleep(300);

  // 从头开始：Shift+Tab 回到文档开头不可靠，改用 Tab 循环采集足够多停靠点
  console.log('=== 真实键盘 Tab 遍历：逐停靠点记录并截图 ===');
  const stops = [];
  for (let i = 1; i <= 20; i++) {
    await cdp.key('Tab', 'Tab', 9);
    await sleep(200);
    const d = await cdp.eval(INFO);
    if (!d) { console.log(`  tab${i} (无 activeElement)`); continue; }
    // 只截取工具栏/侧栏中前若干有意义的控件，避免产出大量文件
    const interesting = d.fv === true && d.tag !== 'BODY';
    stops.push({ i, ...d });
    console.log(`  tab${String(i).padStart(2)} ${d.tag}${d.role ? `[${d.role}]` : ''}${d.type ? `[${d.type}]` : ''} ti=${d.ti} fv=${d.fv} outline=${d.ol} ${d.olw} :: ${(d.label || d.cls).slice(0, 30)}`);
    if (interesting && stops.filter(s => s.fv).length <= 6 && [6, 7, 10, 16].includes(i)) {
      const name = `TASK-043-1${stops.filter(s => s.fv).length - 1}-focus-${d.tag.toLowerCase()}.png`;
      if (await cdp.shot(EV + name)) console.log(`        -> saved ${name} sha=${HASH(EV + name)}`);
    }
  }

  const fvStops = stops.filter(s => s.fv === true && s.tag !== 'BODY');
  console.log(`\n  停靠点总数=${stops.length}  其中 :focus-visible=true 且非 BODY 的=${fvStops.length}`);
  console.log(`  非 BODY 停靠点里 fv=false 的（异常）= ${stops.filter(s => s.tag !== 'BODY' && !s.fv).length}`);
  console.log(`  命中 ti=-1（异常）= ${stops.filter(s => s.ti === -1 && s.tag !== 'BODY').length}`);

  const roles = [...new Set(fvStops.map(s => s.role).filter(Boolean))];
  console.log(`  被 Tab 命中的 role 类型 = ${JSON.stringify(roles)}`);

  console.log('\nDONE');
};
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
