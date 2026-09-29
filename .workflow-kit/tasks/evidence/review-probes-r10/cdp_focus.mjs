// TASK-043 焦点可达性实机验证（CDP 直连 WebView2 渲染器）
// 通过 Input.dispatchKeyEvent 把按键送进渲染器，并读取 document.activeElement。
// 不注入到操作系统层，因此不使用用户的键盘/鼠标、不抢占窗口焦点。
import http from 'node:http';

const PORT = 9222;

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

// --- 极简 CDP over WebSocket ---
import crypto from 'node:crypto';
import net from 'node:net';

class CDP {
  constructor(wsUrl) {
    this.url = new URL(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(Number(this.url.port), this.url.hostname, () => {
        const key = crypto.randomBytes(16).toString('base64');
        this.sock.write(
          `GET ${this.url.pathname} HTTP/1.1\r\n` +
          `Host: ${this.url.host}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let handshake = false;
      this.sock.on('data', (chunk) => {
        if (!handshake) {
          const s = chunk.toString('latin1');
          const idx = s.indexOf('\r\n\r\n');
          if (idx === -1) return;
          handshake = true;
          if (!s.startsWith('HTTP/1.1 101')) return reject(new Error('handshake failed: ' + s.split('\r\n')[0]));
          const rest = chunk.subarray(idx + 4);
          if (rest.length) this._frame(rest);
          resolve();
          return;
        }
        this._frame(chunk);
      });
      this.sock.on('error', reject);
    });
  }
  _frame(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (op === 1) {
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } else if (op === 8) { this.sock.end(); return; }
      if (fin === false) return;
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    const json = JSON.stringify({ id, method, params });
    const payload = Buffer.from(json, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    const len = payload.length;
    if (len < 126) { header = Buffer.alloc(6); header[1] = 0x80 | len; }
    else if (len < 65536) { header = Buffer.alloc(8); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(14); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x81;
    mask.copy(header, header.length - 4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, masked]));
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { error: JSON.stringify(r.result.exceptionDetails) };
    return r.result?.result?.value;
  }
  async key(key, code, vk) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        text: type === 'rawKeyDown' && key === 'Tab' ? '\t' : undefined,
      });
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DESCRIBE = `(() => {
  const el = document.activeElement;
  if (!el) return { none: true };
  const cls = (el.className && typeof el.className === 'string') ? el.className : (el.getAttribute('class') || '');
  return {
    tag: el.tagName,
    cls: cls.slice(0, 70),
    role: el.getAttribute('role'),
    type: el.getAttribute('type'),
    id: el.id || null,
    label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 34),
    tabIndex: el.tabIndex,
  };
})()`;

const FOCUS_RING = `(() => {
  const el = document.activeElement;
  if (!el) return null;
  const s = getComputedStyle(el);
  const ring = [s.outlineStyle, s.outlineWidth, s.outlineColor].join(' ');
  const slider = el.parentElement ? getComputedStyle(el.parentElement) : null;
  return { ring, outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, matchesFV: el.matches(':focus-visible') };
})()`;

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  console.log('CDP connected:', page.url);

  await cdp.send('Runtime.enable');
  await sleep(500);

  // UI 状态探针
  const probe = async () => await cdp.eval(`(() => {
    const q = (s) => !!document.querySelector(s);
    const txt = document.body.innerText || '';
    return {
      settingsOpen: q('.modal-overlay.open .settings-modal') || q('.settings-modal'),
      paletteOpen: q('.cp-list') || q('.search-modal-header'),
      listCards: document.querySelectorAll('[data-card-index]').length,
      visibleEntries: document.querySelectorAll('.article-card, .social-card, .podcast-card, .notif-card, .gallery-card').length,
      hasPlayer: q('.podcast-bottom-bar'),
    };
  })()`);

  console.log('\n=== 初始状态 ===');
  console.log(JSON.stringify(await probe()));

  // 让页面获得焦点（不碰 OS）
  await cdp.eval(`window.focus(); document.body.focus?.(); true`);
  await sleep(300);

  console.log('\n=== 连续 Tab：记录 activeElement 序列 ===');
  const seq = [];
  for (let i = 1; i <= 14; i++) {
    await cdp.key('Tab', 'Tab', 9);
    await sleep(220);
    const d = await cdp.eval(DESCRIBE);
    seq.push(d);
    const ring = await cdp.eval(FOCUS_RING);
    console.log(`  tab${String(i).padStart(2)} -> ${d.tag}${d.role ? `[role=${d.role}]` : ''}${d.type ? `[type=${d.type}]` : ''} ti=${d.tabIndex} fv=${ring?.matchesFV} outline=${ring?.outlineStyle}/${ring?.outlineWidth} :: ${(d.cls || '').slice(0, 46)}`);

  }

  const uniq = new Set(seq.map((s) => `${s.tag}|${s.cls}|${s.role}`));
  console.log(`\nTab 停靠点去重：${uniq.size} 个不同元素 / ${seq.length} 次`);
  const withRing = seq.filter((s) => true).length;
  console.log(`可聚焦元素数：${seq.filter((s) => s.tag).length}`);

  // 判定1：Tab 是否真的移动了焦点
  const moved = uniq.size > 1;
  console.log(`判定 Tab 生效（焦点确实移动）：${moved}`);

  // 判定2：是否存在「不可见/不可聚焦」的停靠点（tabIndex=-1 不应被 Tab 命中）
  const badTi = seq.filter((s) => s.tabIndex === -1);
  console.log(`命中 tabIndex=-1 的元素（应为 0）：${badTi.length}`);

  // 判定3：本轮新增的 roving 卡片 —— 检查卡片是否只暴露一个可 Tab 点
  const cardInfo = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('[data-card-index]')];
    return {
      total: cards.length,
      tabbable: cards.filter(c => c.tabIndex === 0).length,
      roles: [...new Set(cards.map(c => c.getAttribute('role')))],
    };
  })()`);
  console.log('\n=== 列表卡片 roving tabindex ===');
  console.log(JSON.stringify(cardInfo));

  // 判定4：FluxDropdown 触发器可聚焦性
  const ddInfo = await cdp.eval(`(() => {
    const t = document.querySelector('.flux-dropdown-trigger');
    if (!t) return { present: false };
    return { present: true, role: t.getAttribute('role'), tabIndex: t.tabIndex, ariaExpanded: t.getAttribute('aria-expanded'), hasKeydown: !!t.onkeydown };
  })()`);
  console.log('\n=== FluxDropdown 触发器 ===');
  console.log(JSON.stringify(ddInfo));

  // 判定5：关闭态弹窗内的控件是否在 Tab 序列里（复核报告 B-3）
  const closedModal = await cdp.eval(`(() => {
    const ov = document.querySelector('.modal-overlay:not(.open)');
    if (!ov) return { present: false };
    const focusables = ov.querySelectorAll('button, input, textarea, select, a[href], [tabindex]');
    const tabbable = [...focusables].filter(e => e.tabIndex >= 0);
    return { present: true, modalFocusables: focusables.length, tabbableWhenClosed: tabbable.length, inert: ov.hasAttribute('inert'), ariaHidden: ov.getAttribute('aria-hidden') };
  })()`);
  console.log('\n=== 关闭态弹窗（复核 B-3） ===');
  console.log(JSON.stringify(closedModal));

  cdp.sock.end();
  console.log('\nDONE');
};

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
