// 用 headless Edge + CDP 加载**真实构建产物**（无 Tauri → 走 mock 预览分支），
// 切到画廊布局，用真实 Tab 把焦点移到画廊图片，然后：
//   1) 读 computed outline/offset 与卡片裁剪几何
//   2) 逐像素检查截图里被聚焦图片的**四条边**是否都有 accent 描边
// 独立临时 profile；不经系统输入层、不抢用户焦点。
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(process.env.TEMP, 'edge-verify-' + Date.now());
const PORT = 9412;
const EV = 'D:\\fluxreader\\.workflow-kit\\tasks\\evidence\\';
const OUT = EV + 'TASK-043-14-gallery-focus-inset.png';

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
    if(r.result?.exceptionDetails) return {__err:(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text||'').slice(0,220)};
    return r.result?.result?.value; }
  async key(key,code,vk){ await this.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk}); }
  async shot(p){ const r=await this.send('Page.captureScreenshot',{format:'png'}); if(!r.result?.data)return false;
    fs.writeFileSync(p,Buffer.from(r.result.data,'base64')); return true; }
}

const main = async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1400,1000',
    'file:///D:/fluxreader/dist/index.html',
  ], { stdio: 'ignore' });
  console.log('Edge pid=', child.pid);

  let list=null;
  for (let i=0;i<40;i++){ await sleep(500); try{ list=JSON.parse(await httpGet('/json/list')); if(list.some(t=>t.type==='page'))break; }catch{} }
  if(!list){ console.log('CDP 未就绪'); child.kill(); process.exit(1); }
  const page=list.find(t=>t.type==='page'); console.log('target:', page.url);

  const cdp=new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await sleep(2500);

  // 页面渲染状态
  const boot=await cdp.eval(`(()=>({
    title: document.title,
    hasSidebar: !!document.querySelector('.sidebar'),
    layouts: [...document.querySelectorAll('.sidebar *')].filter(e=>/画廊/.test(e.textContent||'')).length,
    bodyText: (document.body.innerText||'').slice(0,120)
  }))()`);
  console.log('boot:', JSON.stringify(boot));

  // 切到画廊：找含「画廊」的可点击元素并点击
  const clicked = await cdp.eval(`(()=>{
    const els=[...document.querySelectorAll('.sidebar *')].filter(e=>{
      const t=(e.textContent||'').trim();
      return t==='画廊' && e.children.length<=2;
    });
    if(!els.length) return {ok:false, n:0};
    const el=els[els.length-1];
    el.click();
    return {ok:true, tag:el.tagName, cls:(el.className||'').toString().slice(0,40)};
  })()`);
  console.log('切画廊:', JSON.stringify(clicked));
  await sleep(1500);

  const gal=await cdp.eval(`(()=>{
    const cards=[...document.querySelectorAll('.gallery-card')];
    const imgs=[...document.querySelectorAll('.gallery-card img')];
    return {cards:cards.length, imgs:imgs.length,
            tabbable: imgs.filter(i=>i.tabIndex===0).length,
            roles:[...new Set(imgs.map(i=>i.getAttribute('role')))]};
  })()`);
  console.log('画廊 DOM:', JSON.stringify(gal));

  if (gal.imgs > 0) {
    // 用真实 Tab 把焦点移到那张可 Tab 的图片
    await cdp.eval('window.focus(); document.body.focus?.(); true');
    await sleep(200);
    let found=null;
    for (let i=0;i<40;i++){
      await cdp.key('Tab','Tab',9); await sleep(90);
      const cur=await cdp.eval(`(()=>{const el=document.activeElement;
        return el ? {tag:el.tagName, inGallery: !!el.closest('.gallery-card'), fv:el.matches(':focus-visible'), ti:el.tabIndex} : null;})()`);
      if (cur && cur.inGallery) { found=cur; break; }
    }
    console.log('Tab 到达画廊图片:', JSON.stringify(found));

    const info=await cdp.eval(`(()=>{
      const el=document.activeElement;
      if(!el || !el.closest('.gallery-card')) return {none:true};
      const cs=getComputedStyle(el), card=el.closest('.gallery-card'), ccs=getComputedStyle(card);
      const r=el.getBoundingClientRect(), cr=card.getBoundingClientRect();
      return {
        tag:el.tagName, fv:el.matches(':focus-visible'),
        outline: cs.outlineStyle+' '+cs.outlineWidth+' '+cs.outlineColor,
        offset: cs.outlineOffset,
        cardOverflow: ccs.overflow, cardPadding: ccs.padding,
        gapLeft: Math.round(r.left-cr.left), gapTop: Math.round(r.top-cr.top),
        gapRight: Math.round(cr.right-r.right), gapBottom: Math.round(cr.bottom-r.bottom),
      };
    })()`);
    console.log('\n=== 焦点元素计算样式与裁剪几何 ===');
    console.log(JSON.stringify(info,null,1));

    await sleep(400);
    if (await cdp.shot(OUT)) {
      const h=crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex').slice(0,16);
      console.log(`\nsaved TASK-043-14-gallery-focus-inset.png  sha=${h}  ${fs.statSync(OUT).size} bytes`);
    }
  } else {
    console.log('画廊无图片，无法验证');
  }

  cdp.sock.end(); await sleep(300);
  try{ child.kill(); }catch{}
  await sleep(900);
  try{ fs.rmSync(PROFILE,{recursive:true,force:true}); console.log('临时 profile 已删除'); }catch{}
  console.log('DONE');
};
main().catch(e=>{ console.error('FAILED:', e.message); process.exit(1); });
