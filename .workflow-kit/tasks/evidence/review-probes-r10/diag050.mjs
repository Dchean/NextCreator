// 定向判定：那条 net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin 是否与「打开设置」有关？
// 做法：注入同样的 mock，先什么都不做观察一段（不打开设置），再打开设置，分别计数。
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';

const PORT = 9222;
const httpGet = (p) => new Promise((res, rej) => {
  http.get({ host:'127.0.0.1', port:PORT, path:p }, (r)=>{ let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class CDP {
  constructor(u){ this.url=new URL(u); this.id=0; this.pending=new Map(); this.buf=Buffer.alloc(0); this.events=[]; }
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
      if(op===1){ const m=JSON.parse(pl.toString('utf8'));
        if(m.id&&this.pending.has(m.id)){ this.pending.get(m.id)(m); this.pending.delete(m.id); }
        else if(m.method){ this.events.push(m); } }
      else if(op===8){ this.sock.end(); return; } } }
  send(method,params={}){ const id=++this.id; const pl=Buffer.from(JSON.stringify({id,method,params}),'utf8');
    const mask=crypto.randomBytes(4); let h; const L=pl.length;
    if(L<126){h=Buffer.alloc(6);h[1]=0x80|L;} else if(L<65536){h=Buffer.alloc(8);h[1]=0x80|126;h.writeUInt16BE(L,2);} else {h=Buffer.alloc(14);h[1]=0x80|127;h.writeBigUInt64BE(BigInt(L),2);}
    h[0]=0x81; mask.copy(h,h.length-4); const m=Buffer.alloc(L); for(let i=0;i<L;i++)m[i]=pl[i]^mask[i%4];
    this.sock.write(Buffer.concat([h,m])); return new Promise(r=>this.pending.set(id,r)); }
  async eval(e){ const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});
    if(r.result?.exceptionDetails) return {__err:(r.result.exceptionDetails.exception?.description||'').slice(0,200)};
    return r.result?.result?.value; }
}
const errList = (cdp, from) => cdp.events.slice(from).filter(e =>
  e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && ['error','warning'].includes(e.params?.type)) ||
  (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'));

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const cdp = new CDP(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
  await sleep(1500);

  // 关键：先清空已积累事件，再注入 mock（不打开设置），观察 4 秒
  cdp.events.length = 0;
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore;
    const mk=await import('/src/mockData.ts');
    const cats=mk.createInitialCategories(), entries=mk.createInitialEntries();
    const fi=new Map(); for(const c of cats) for(const f of c.feeds) fi.set(f.id,{feed:f,cat:c});
    s.setState({dataMode:'mock',dataLoading:false,categories:cats,feedIndex:fi,entries,
      activeContentLayout:'article',activeViewFilter:'all',activeFeedFilter:'all',timelineFilter:'all',
      settingsOpen:false,searchOpen:false,activeArticleId:null,lightboxUrl:null});
    return true;})()`);
  await sleep(4000);
  const phaseA = errList(cdp, 0);
  console.log(`  阶段 A（注入 mock，**未打开设置**）: ${phaseA.length} 条`);
  for (const e of phaseA) {
    const d = e.params?.entry?.text || e.params?.exceptionDetails?.exception?.description
      || (e.params?.args||[]).map(a=>a.value??a.description).join(' ');
    console.log('     - ' + String(d).slice(0,140));
  }

  const mark = cdp.events.length;
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().openSettings(); return true;})()`);
  await sleep(3000);
  // 走一遍 8 个页签
  for (let i=0;i<8;i++){ await cdp.eval(`(async()=>{document.querySelectorAll('.settings-nav-item')[${i}]?.click(); await new Promise(r=>setTimeout(r,200)); return true;})()`); await sleep(220); }
  await sleep(1000);
  const phaseB = errList(cdp, mark);
  console.log(`  阶段 B（打开设置并遍历 8 页签）: ${phaseB.length} 条`);
  for (const e of phaseB) {
    const d = e.params?.entry?.text || e.params?.exceptionDetails?.exception?.description
      || (e.params?.args||[]).map(a=>a.value??a.description).join(' ');
    console.log('     - ' + String(d).slice(0,140));
  }

  console.log('\n  判定：');
  if (phaseA.length > 0 && phaseB.length === 0) console.log('    → 该错误在**未打开设置时**就已出现 ⇒ 与本任务拆分无关（预先存在）');
  else if (phaseA.length === 0 && phaseB.length > 0) console.log('    → 仅打开设置后出现 ⇒ 可能与拆分有关，需进一步排查');
  else if (phaseA.length > 0 && phaseB.length > 0) console.log('    → 两阶段都有 ⇒ 预先存在；且设置阶段未新增');
  else console.log('    → 两阶段均无错误');

  // 追加：确认错误来源 URL
  const urls = cdp.events.filter(e=>e.method==='Log.entryAdded').map(e=>e.params?.entry?.url).filter(Boolean);
  console.log(`  涉及的资源 URL（去重，最多 6 个）: ${[...new Set(urls)].slice(0,6).join(' | ') || '(无)'}`);
  cdp.sock.end(); console.log('DONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
