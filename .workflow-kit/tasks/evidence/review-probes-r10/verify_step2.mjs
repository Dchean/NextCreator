// 定向验证：设置弹窗打开时，Tab 最终能否进入其控件，且焦点环可见。
// 前次因 cap=30 < 主视图 32 个停靠点而误判；本次走满一圈。
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';

const PORT = 9222;
const EV = 'D:\\fluxreader\\.workflow-kit\\tasks\\evidence\\';
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
  async shot(p){ const r=await this.send('Page.captureScreenshot',{format:'png'}); if(!r.result?.data)return false;
    fs.writeFileSync(p,Buffer.from(r.result.data,'base64')); return true; }
}
const PROBE = `(()=>{const e=document.activeElement; if(!e) return null;
  if(!e.__p2) e.__p2='q'+(window.__q=(window.__q||0)+1);
  const ov=e.closest('.modal-overlay');
  return {id:e.__p2, tag:e.tagName, cls:String(e.className||'').slice(0,28), inOverlay:!!ov,
          fv:e.matches(':focus-visible')};})()`;

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const cdp = new CDP(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await sleep(1200);
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().openSettings(); return true;})()`);
  await sleep(900);

  const ov = await cdp.eval(`(()=>{const e=[...document.querySelectorAll('.modal-overlay')].find(x=>x.classList.contains('open'));
    return e?{open:true,inert:e.hasAttribute('inert'),
      tabbable:[...e.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(n=>n.tabIndex>=0&&!n.disabled).length}:null;})()`);
  console.log('  打开中的浮层:', JSON.stringify(ov));

  // 从 body 起走满一圈（cap 80）
  await cdp.eval(`document.activeElement?.blur(); document.body.focus?.(); window.__q=0; true`);
  await sleep(200);
  const stops=[]; let first=null; let shotDone=false;
  for (let i=0;i<80;i++){
    await cdp.key('Tab','Tab',9); await sleep(40);
    const c = await cdp.eval(PROBE);
    if(!c||c.__err) break;
    if(first===null) first=c.id; else if(c.id===first) break;
    stops.push(c);
    if (c.inOverlay && !shotDone) { await cdp.shot(EV + 'TASK-047-02-settings-open-focus-ring.png'); shotDone=true; }
  }
  const inOv = stops.filter(s=>s.inOverlay);
  console.log(`  Tab 停靠点 ${stops.length} 个（走满一圈）`);
  console.log(`  其中位于浮层内: ${inOv.length} 个  => 打开态可进入 ${inOv.length>0?'✓ 成立':'❌ 失败'}`);
  console.log(`  浮层内带 :focus-visible 的: ${inOv.filter(s=>s.fv).length} 个  => 焦点环可见 ${inOv.some(s=>s.fv)?'✓':'❌'}`);
  console.log(`  主视图停靠点: ${stops.filter(s=>!s.inOverlay).length} 个`);
  console.log(`  进入浮层前的停靠点数: ${stops.findIndex(s=>s.inOverlay)}`);
  console.log(`  浮层内停靠点序列: ${inOv.map(s=>s.tag+'.'+s.cls.split(' ')[0]).slice(0,12).join(' → ')}`);
  console.log(`  截图: ${shotDone?'TASK-047-02-settings-open-focus-ring.png 已存':'未拍到浮层内焦点'}`);
  cdp.sock.end(); console.log('DONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
