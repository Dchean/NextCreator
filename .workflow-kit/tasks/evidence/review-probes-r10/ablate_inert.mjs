// 消融对照：同一状态、同一遍历方法，分别在「有 inert」与「临时移除 inert」下走一圈。
// 目的：(a) 证明 inert 是生效点；(b) 证明本次改动只减少停靠点、未新增。
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
const PROBE = `(()=>{const e=document.activeElement; if(!e) return null;
  if(!e.__ab) e.__ab='a'+(window.__a=(window.__a||0)+1);
  return {id:e.__ab, tag:e.tagName, cls:String(e.className||'').slice(0,26), inOverlay:!!e.closest('.modal-overlay')};})()`;

const walkOnce = async (cdp, cap=120) => {
  await cdp.eval(`document.activeElement?.blur(); document.body.focus?.(); window.__a=0; true`);
  await sleep(180);
  const stops=[]; let first=null;
  for (let i=0;i<cap;i++){
    await cdp.key('Tab','Tab',9); await sleep(35);
    const c = await cdp.eval(PROBE);
    if(!c||c.__err) break;
    if(first===null) first=c.id; else if(c.id===first) break;
    stops.push(c);
  }
  return stops;
};

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const cdp = new CDP(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable');
  await sleep(1200);
  // 确保全关
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore;
    s.setState({settingsOpen:false,searchOpen:false,lightboxUrl:null}); return true;})()`);
  await sleep(700);

  const withInert = await walkOnce(cdp);
  const inA = withInert.filter(s=>s.inOverlay).length;
  console.log(`  [有 inert]   停靠点 ${withInert.length}，其中浮层内 ${inA}`);

  // 临时移除 inert（消融）
  const removed = await cdp.eval(`(()=>{const els=[...document.querySelectorAll('[inert]')];
    els.forEach(e=>{e.__savedInert=true; e.removeAttribute('inert');}); return els.length;})()`);
  console.log(`  临时移除 inert 的节点数: ${removed}`);
  await sleep(300);
  const noInert = await walkOnce(cdp);
  const inB = noInert.filter(s=>s.inOverlay).length;
  console.log(`  [移除 inert] 停靠点 ${noInert.length}，其中浮层内 ${inB}`);

  // 还原
  const restored = await cdp.eval(`(()=>{const els=[...document.querySelectorAll('.modal-overlay')];
    let n=0; els.forEach(e=>{ if(e.__savedInert){ e.setAttribute('inert',''); delete e.__savedInert; n++; }}); return n;})()`);
  console.log(`  已还原 inert 的节点数: ${restored}`);
  await sleep(300);
  const again = await walkOnce(cdp);
  console.log(`  [还原后]     停靠点 ${again.length}，其中浮层内 ${again.filter(s=>s.inOverlay).length}`);

  console.log('\n  === 判定 ===');
  console.log(`  inert 使浮层内停靠点从 ${inB} 降到 ${inA}  => 修复生效 ${inA===0 && inB>0 ? '✓' : '❌'}`);
  console.log(`  主视图停靠点未变: ${withInert.filter(s=>!s.inOverlay).length} vs ${noInert.filter(s=>!s.inOverlay).length}  => ${withInert.filter(s=>!s.inOverlay).length===noInert.filter(s=>!s.inOverlay).length ? '✓ 未新增/未减少' : '⚠ 有变化'}`);
  cdp.sock.end(); console.log('DONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
