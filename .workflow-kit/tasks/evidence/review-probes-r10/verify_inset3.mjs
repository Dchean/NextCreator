// 在真实 Tauri WebView2 上验证画廊焦点环修复（内描边）：
// 注入内存 mock → 切画廊 → 真实 Tab 聚焦图片 → 读几何 + 截图 → 逐边像素判定。
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const PORT = 9222;
const EV = 'D:\\fluxreader\\.workflow-kit\\tasks\\evidence\\';
const OUT = EV + 'TASK-043-14-gallery-focus-inset.png';
const httpGet = (p) => new Promise((res, rej) => {
  http.get({ host:'127.0.0.1', port:PORT, path:p }, (r)=>{ let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error', rej);
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
  const list = JSON.parse(await httpGet('/json/list'));
  const page = list.find(t=>t.type==='page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await sleep(1500);

  // 注入内存 mock（不写库）并切到画廊
  const inj = await cdp.eval(`(async()=>{
    try{
      const s=(await import('/src/store.ts')).useAppStore;
      const mk=await import('/src/mockData.ts');
      const cats=mk.createInitialCategories(), entries=mk.createInitialEntries();
      const fi=new Map(); for(const c of cats) for(const f of c.feeds) fi.set(f.id,{feed:f,cat:c});
      s.setState({dataMode:'mock',dataLoading:false,categories:cats,feedIndex:fi,entries,
        activeContentLayout:'image',activeViewFilter:'all',activeFeedFilter:'all',timelineFilter:'all',
        settingsOpen:false,searchOpen:false,activeArticleId:null});
      return {ok:true};
    }catch(e){return{ok:false,err:String(e&&e.message||e).slice(0,160)};}
  })()`);
  console.log('注入+切画廊:', JSON.stringify(inj));
  await sleep(1800);

  const dom = await cdp.eval(`(()=>{const imgs=[...document.querySelectorAll('.gallery-card img')];
    return {cards:document.querySelectorAll('.gallery-card').length, imgs:imgs.length,
            tabbable:imgs.filter(i=>i.tabIndex===0).length, roles:[...new Set(imgs.map(i=>i.getAttribute('role')))]};})()`);
  console.log('画廊 DOM:', JSON.stringify(dom));

  // 真实 Tab 聚焦图片
  await cdp.eval('window.focus(); document.body.focus?.(); true');
  await sleep(200);
  let hit=null;
  for (let i=0;i<50;i++){
    await cdp.key('Tab','Tab',9); await sleep(80);
    const cur=await cdp.eval(`(()=>{const el=document.activeElement;
      return el?{tag:el.tagName,inGallery:!!el.closest('.gallery-card'),fv:el.matches(':focus-visible')}:null;})()`);
    if(cur && cur.inGallery){ hit=cur; break; }
  }
  console.log('Tab 到达画廊图片:', JSON.stringify(hit));

  const info = await cdp.eval(`(()=>{
    const el=document.activeElement;
    if(!el || !el.closest('.gallery-card')) return {none:true};
    const cs=getComputedStyle(el), card=el.closest('.gallery-card'), ccs=getComputedStyle(card);
    const r=el.getBoundingClientRect(), cr=card.getBoundingClientRect();
    return {tag:el.tagName, fv:el.matches(':focus-visible'),
      outline:cs.outlineStyle+' '+cs.outlineWidth+' '+cs.outlineColor, offset:cs.outlineOffset,
      cardOverflow:ccs.overflow,
      gaps:{left:Math.round(r.left-cr.left),top:Math.round(r.top-cr.top),
            right:Math.round(cr.right-r.right),bottom:Math.round(cr.bottom-r.bottom)},
      rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]};
  })()`);
  console.log('\n=== 焦点元素计算样式与裁剪余量 ===');
  console.log(JSON.stringify(info,null,1));

  await sleep(400);
  if (await cdp.shot(OUT)) {
    const h=crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex').slice(0,16);
    console.log(`\nsaved: ${OUT.split('\\\\').pop()}  sha=${h}  ${fs.statSync(OUT).size} bytes`);
  }

  cdp.sock.end();
  console.log('DONE');
};
main().catch(e=>{ console.error('FAILED:', e.message); process.exit(1); });
