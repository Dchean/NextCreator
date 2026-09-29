// 调试 step 2：设置弹窗打开时，逐个打印 Tab 停靠点，看为什么没进浮层。
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';

const PORT = 9222;
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
    if(r.result?.exceptionDetails) return {__err:(r.result.exceptionDetails.exception?.description||'').slice(0,200)};
    return r.result?.result?.value; }
  async key(key,code,vk){ await this.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk}); }
}

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const cdp = new CDP(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable');
  await sleep(1200);

  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore;
    const mk=await import('/src/mockData.ts');
    const cats=mk.createInitialCategories(), entries=mk.createInitialEntries();
    const fi=new Map(); for(const c of cats) for(const f of c.feeds) fi.set(f.id,{feed:f,cat:c});
    s.setState({dataMode:'mock',dataLoading:false,categories:cats,feedIndex:fi,entries,
      activeContentLayout:'article',activeViewFilter:'all',activeFeedFilter:'all',timelineFilter:'all',
      settingsOpen:true,searchOpen:false,activeArticleId:null,lightboxUrl:null});
    return true;})()`);
  await sleep(1000);

  // 浮层现状 + 它内部可聚焦元素数量
  const info = await cdp.eval(`(()=>{
    const ov=[...document.querySelectorAll('.modal-overlay')].find(e=>e.classList.contains('open'));
    if(!ov) return {none:true, all:[...document.querySelectorAll('.modal-overlay')].map(e=>e.className)};
    const focusables=[...ov.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')]
      .filter(n=>n.tabIndex>=0 && !n.disabled);
    return {cls:ov.className, inert:ov.hasAttribute('inert'), focusables:focusables.length,
            first3: focusables.slice(0,3).map(n=>n.tagName+'.'+String(n.className).slice(0,24)),
            ovId: ov.id || '(no id)'};})()`);
  console.log('  打开的浮层:', JSON.stringify(info));

  // 直接从浮层内聚焦第一个控件，确认它是可聚焦的
  const canFocus = await cdp.eval(`(()=>{
    const ov=[...document.querySelectorAll('.modal-overlay')].find(e=>e.classList.contains('open'));
    const f=[...ov.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(n=>n.tabIndex>=0 && !n.disabled)[0];
    if(!f) return {none:true}; f.focus();
    return {focused: document.activeElement===f, tag:f.tagName, fv:f.matches(':focus-visible')};})()`);
  console.log('  直接 focus 浮层内首个控件:', JSON.stringify(canFocus));

  // 逐个 Tab
  await cdp.eval(`document.activeElement?.blur(); document.body.focus?.(); true`);
  await sleep(200);
  console.log('\n  从 body 起 Tab 15 次：');
  for (let i=1;i<=15;i++){
    await cdp.key('Tab','Tab',9); await sleep(60);
    const c = await cdp.eval(`(()=>{const e=document.activeElement; if(!e) return null;
      const ov=e.closest('.modal-overlay');
      return {n:${i}, tag:e.tagName, cls:String(e.className||'').slice(0,26),
              inOverlay:!!ov, ovClass: ov?String(ov.className).slice(0,28):null,
              inertAnc: !!e.closest('[inert]')};})()`);
    console.log('   ' + JSON.stringify(c));
  }
  cdp.sock.end(); console.log('DONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
