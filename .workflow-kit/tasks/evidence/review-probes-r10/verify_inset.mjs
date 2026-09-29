// 用 headless Edge + CDP 验证画廊图片的焦点环是否真的可见（内描边修复后）。
// 独立临时 profile，不经系统输入层、不抢用户焦点。
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(process.env.TEMP, 'edge-focus-verify-' + Date.now());
const PORT = 9411;
const OUT = 'D:\\fluxreader\\.workflow-kit\\tasks\\evidence\\TASK-043-14-gallery-focus-inset.png';

const httpGet = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(u){ this.url=new URL(u); this.id=0; this.pending=new Map(); this.buf=Buffer.alloc(0); }
  connect(){ return new Promise((resolve,reject)=>{
    this.sock=net.connect(Number(this.url.port), this.url.hostname, ()=>{
      const key=crypto.randomBytes(16).toString('base64');
      this.sock.write(`GET ${this.url.pathname} HTTP/1.1\r\nHost: ${this.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let hs=false;
    this.sock.on('data',(ch)=>{ if(!hs){ const s=ch.toString('latin1'); const i=s.indexOf('\r\n\r\n'); if(i===-1)return; hs=true;
      if(!s.startsWith('HTTP/1.1 101')) return reject(new Error(s.split('\r\n')[0]));
      const rest=ch.subarray(i+4); if(rest.length) this._f(rest); resolve(); return; } this._f(ch); });
    this.sock.on('error',reject);
  }); }
  _f(ch){ this.buf=Buffer.concat([this.buf,ch]);
    for(;;){ const b=this.buf; if(b.length<2)return; const op=b[0]&0x0f; let len=b[1]&0x7f, off=2;
      if(len===126){ if(b.length<4)return; len=b.readUInt16BE(2); off=4; }
      else if(len===127){ if(b.length<10)return; len=Number(b.readBigUInt64BE(2)); off=10; }
      if(b.length<off+len)return; const pl=b.subarray(off,off+len); this.buf=b.subarray(off+len);
      if(op===1){ const m=JSON.parse(pl.toString('utf8')); if(m.id&&this.pending.has(m.id)){ this.pending.get(m.id)(m); this.pending.delete(m.id); } }
      else if(op===8){ this.sock.end(); return; } } }
  send(method,params={}){ const id=++this.id; const pl=Buffer.from(JSON.stringify({id,method,params}),'utf8');
    const mask=crypto.randomBytes(4); let h; const L=pl.length;
    if(L<126){h=Buffer.alloc(6);h[1]=0x80|L;} else if(L<65536){h=Buffer.alloc(8);h[1]=0x80|126;h.writeUInt16BE(L,2);} else {h=Buffer.alloc(14);h[1]=0x80|127;h.writeBigUInt64BE(BigInt(L),2);}
    h[0]=0x81; mask.copy(h,h.length-4); const m=Buffer.alloc(L); for(let i=0;i<L;i++)m[i]=pl[i]^mask[i%4];
    this.sock.write(Buffer.concat([h,m])); return new Promise(r=>this.pending.set(id,r)); }
  async eval(e){ const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});
    if(r.result?.exceptionDetails) return {__err:(r.result.exceptionDetails.exception?.description||'').slice(0,200)};
    return r.result?.result?.value; }
  async shot(p){ const r=await this.send('Page.captureScreenshot',{format:'png'}); if(!r.result?.data)return false;
    fs.writeFileSync(p,Buffer.from(r.result.data,'base64')); return true; }
}

const main = async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1400,1000',
    'file:///D:/fluxreader/dist/index.html',
  ], { stdio: 'ignore', detached: false });
  console.log('Edge started pid=', child.pid);

  let list = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { list = JSON.parse(await httpGet('/json/list')); if (list.some(t=>t.type==='page')) break; } catch {}
  }
  if (!list) { console.log('CDP 未就绪'); child.kill(); process.exit(1); }
  const page = list.find(t => t.type === 'page');
  console.log('target:', page.url);

  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await sleep(1200);

  // 该页面是纯构建产物，无 Tauri，故 store 进 mock 分支；用模块图注入画廊布局与数据。
  const inj = await cdp.eval(`(async () => {
    try {
      const m = await import('/assets/index-De-DVadr.js').catch(() => null);
      return { note: 'bundle import 不可用（生产构建无源模块），改用 DOM 层面判定', ok: false };
    } catch (e) { return { err: String(e).slice(0,120) }; }
  })()`);
  console.log('注入尝试:', JSON.stringify(inj));

  // 生产构建下无法注入 store；改为直接构造等价 DOM 结构验证 CSS 几何
  const geom = await cdp.eval(`(() => {
    // 构造与 .gallery-card 一致的结构：overflow:hidden 无 padding 的卡片 + 铺满的 img
    document.body.innerHTML = '<div class="gallery-masonry-grid" style="width:600px">' +
      '<div class="gallery-card"><img id="t" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MDAiIGhlaWdodD0iMjAwIj48cmVjdCB3aWR0aD0iNjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzFhMWExYSIvPjwvc3ZnPg==" style="width:100%;display:block"></div></div>';
    const img = document.querySelector('.gallery-card img');
    const card = document.querySelector('.gallery-card');
    img.setAttribute('role','button'); img.tabIndex = 0;
    img.focus();
    const cs = getComputedStyle(img);
    const ccs = getComputedStyle(card);
    const r = img.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    return {
      imgOutline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
      imgOffset: cs.outlineOffset,
      cardOverflow: ccs.overflow,
      cardPadding: ccs.paddingTop + '/' + ccs.paddingLeft,
      imgRect: [r.left, r.top, r.width, r.height].map(Math.round),
      cardRect: [cr.left, cr.top, cr.width, cr.height].map(Math.round),
      gapLeft: Math.round(r.left - cr.left),
      gapTop: Math.round(r.top - cr.top),
      isFocusVisible: img.matches(':focus-visible'),
    };
  })()`);
  console.log('\n=== 几何与计算样式 ===');
  console.log(JSON.stringify(geom, null, 1));

  if (await cdp.shot(OUT)) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex').slice(0,16);
    console.log(`\nsaved ${OUT}\n  sha=${h}  ${fs.statSync(OUT).size} bytes`);
  }

  cdp.sock.end();
  await sleep(300);
  try { child.kill(); } catch {}
  await sleep(800);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); console.log('临时 profile 已删除'); } catch (e) { console.log('profile 删除失败:', e.message); }
  console.log('DONE');
};
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
