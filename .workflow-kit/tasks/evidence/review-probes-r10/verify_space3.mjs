// 连接**已运行的 Tauri WebView2**（--remote-debugging-port=9222），
// 验证 Space 双重动作修复。不 spawn 浏览器、不注入系统键鼠。
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
    if(r.result?.exceptionDetails) return {__err:(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text||'').slice(0,200)};
    return r.result?.result?.value; }
  async keyRaw(key,code,vk){ await this.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk}); }
}

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const page = list.find(t=>t.type==='page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable');
  await sleep(1200);
  console.log('CDP connected:', page.url);

  const inj = await cdp.eval(`(async()=>{
    try{
      const s=(await import('/src/store.ts')).useAppStore;
      const mk=await import('/src/mockData.ts');
      const cats=mk.createInitialCategories(), entries=mk.createInitialEntries();
      const fi=new Map(); for(const c of cats) for(const f of c.feeds) fi.set(f.id,{feed:f,cat:c});
      s.setState({dataMode:'mock',dataLoading:false,categories:cats,feedIndex:fi,entries,
        activeContentLayout:'article',activeViewFilter:'all',activeFeedFilter:'all',timelineFilter:'all',
        settingsOpen:false,searchOpen:false,activeArticleId:null,
        player:{...s.getState().player, isActive:true, isPlaying:false,
                audioUrl:'', title:'t', showName:'s', positionSec:0, durationSec:100}});
      const st=s.getState();
      if(!window.__probe){ window.__probe={calls:0};
        const orig=st.togglePlayerPlay;
        s.setState({togglePlayerPlay:(...a)=>{ window.__probe.calls++; return orig(...a); }}); }
      window.__probe.calls=0;
      return {ok:true, isActive:s.getState().player.isActive};
    }catch(e){return{ok:false,err:String(e&&e.message||e).slice(0,180)};}
  })()`);
  console.log('注入:', JSON.stringify(inj));
  await sleep(1200);

  const dom = await cdp.eval(`(()=>({cards:document.querySelectorAll('[data-card-index]').length,
    tabbable:[...document.querySelectorAll('[data-card-index]')].filter(c=>c.tabIndex===0).length}))()`);
  console.log('卡片:', JSON.stringify(dom));

  const reset = async () => { await cdp.eval(`window.__probe.calls=0; true`); };
  const calls = async () => await cdp.eval(`window.__probe.calls`);
  const state = async () => await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore.getState();
    return {activeArticleId:s.activeArticleId, isPlaying:s.player.isPlaying, isActive:s.player.isActive};})()`);

  console.log('\n=== A) 焦点在 article-card 按 Space（期望：只开文章，togglePlayerPlay=0）===');
  await cdp.eval(`document.querySelector('[data-card-index]')?.focus(); true`);
  await sleep(300);
  await reset();
  const bA = await state();
  await cdp.keyRaw(' ','Space',32);
  await sleep(800);
  const aA = await state();
  const cA = await calls();
  console.log(`  activeArticleId: ${bA.activeArticleId} -> ${aA.activeArticleId}`);
  console.log(`  togglePlayerPlay 次数 = ${cA}  (期望 0)`);

  console.log('\n=== B) 对照：焦点在 body 按 Space（期望：仍切播放）===');
  await cdp.eval(`document.activeElement?.blur(); document.body.focus?.(); true`);
  await sleep(300);
  await reset();
  await cdp.keyRaw(' ','Space',32);
  await sleep(800);
  const cB = await calls();
  console.log(`  togglePlayerPlay 次数 = ${cB}  (期望 ≥1)`);

  console.log('\n=== C) 对照：Enter 不受影响 ===');
  await cdp.eval(`document.querySelector('[data-card-index]')?.focus(); true`);
  await sleep(250);
  await reset();
  const bC = await state();
  await cdp.keyRaw('Enter','Enter',13);
  await sleep(700);
  const cC = await calls();
  const aC = await state();
  console.log(`  togglePlayerPlay=${cC} (期望 0); 卡片动作=${bC.activeArticleId !== aC.activeArticleId}`);

  console.log('\n=== D) 下拉触发器按 Space（期望：开合下拉，togglePlayerPlay=0）===');
  await cdp.eval(`document.querySelector('.flux-dropdown-trigger')?.focus(); true`);
  await sleep(250);
  await reset();
  const opened = await cdp.eval(`(()=>{const t=document.querySelector('.flux-dropdown-trigger');
     return t? t.getAttribute('aria-expanded'):null;})()`);
  await cdp.keyRaw(' ','Space',32);
  await sleep(600);
  const cD = await calls();
  const opened2 = await cdp.eval(`(()=>{const t=document.querySelector('.flux-dropdown-trigger');
     return t? t.getAttribute('aria-expanded'):null;})()`);
  console.log(`  aria-expanded: ${opened} -> ${opened2}; togglePlayerPlay=${cD} (期望 0)`);

  console.log('\n=== 判定 ===');
  const okA = cA === 0 && bA.activeArticleId !== aA.activeArticleId;
  const okB = cB >= 1;
  const okC = cC === 0;
  const okD = cD === 0;
  console.log(`  A 无双重动作且控件生效 = ${okA}`);
  console.log(`  B Space 仍可播放        = ${okB}`);
  console.log(`  C Enter 不受影响        = ${okC}`);
  console.log(`  D 下拉 Space 无双重动作  = ${okD}`);
  console.log(`  => 修复${(okA&&okB&&okC&&okD) ? ' ✓ 成立' : ' ❌ 仍有问题'}`);

  cdp.sock.end();
  console.log('DONE');
};
main().catch(e=>{ console.error('FAILED:', e.message); process.exit(1); });
