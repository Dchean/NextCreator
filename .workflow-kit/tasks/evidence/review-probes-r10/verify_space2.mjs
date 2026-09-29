// 楠岃瘉 Space 鍙岄噸鍔ㄤ綔淇锛?//  A) 鎾斁鍣ㄦ縺娲绘椂锛屽銆屾柊鑱氱劍鎺т欢銆嶏紙article-card / 涓嬫媺瑙﹀彂鍣級鎸?Space 鈫?//     搴斿彧鎵ц鎺т欢鍔ㄤ綔锛?*涓?*瑙﹀彂 togglePlayerPlay銆?//  B) 瀵圭収缁勶細鐒︾偣涓嶅湪浠讳綍鑷畾涔夊彲鑱氱劍鎺т欢涓婏紙body锛夋椂鎸?Space 鈫?浠嶅簲鍒囨崲鎾斁銆?// 鐢?headless Edge + CDP锛岀嫭绔嬩复鏃?profile锛屼笉缁忕郴缁熻緭鍏ュ眰銆?import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EDGE = null;
const PROFILE = path.join(process.env.TEMP, 'edge-space-' + Date.now());
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
  async keyRaw(key,code,vk){ await this.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk}); }
}

const main = async () => {
  fs.mkdirSync(PROFILE,{recursive:true});
  const child = spawn(EDGE, ['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,
    '--no-first-run','--no-default-browser-check','--disable-gpu','--autoplay-policy=no-user-gesture-required',
    '--window-size=1400,1000','http://localhost:5173/'], { stdio:'ignore' });
  console.log('Edge pid=',child.pid);

  let list=null;
  for(let i=0;i<40;i++){ await sleep(500); try{ list=JSON.parse(await httpGet('/json/list')); if(list.some(t=>t.type==='page'))break; }catch{} }
  if(!list){ console.log('CDP 鏈氨缁?); child.kill(); process.exit(1); }
  const page=list.find(t=>t.type==='page');
  const cdp=new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await sleep(1500);

  // 娉ㄥ叆鍐呭瓨 mock锛歛rticle 甯冨眬 + 涓€寮犲崱锛涘苟鎶婃挱鏀惧櫒璁句负婵€娲?  const inj = await cdp.eval(`(async()=>{
    try{
      const s=(await import('/src/store.ts')).useAppStore;
      const mk=await import('/src/mockData.ts');
      const cats=mk.createInitialCategories(), entries=mk.createInitialEntries();
      const fi=new Map(); for(const c of cats) for(const f of c.feeds) fi.set(f.id,{feed:f,cat:c});
      s.setState({dataMode:'mock',dataLoading:false,categories:cats,feedIndex:fi,entries,
        activeContentLayout:'article',activeViewFilter:'all',activeFeedFilter:'all',timelineFilter:'all',
        settingsOpen:false,searchOpen:false,activeArticleId:null,
        player:{...s.getState().player, isActive:true, isPlaying:false,
                audioUrl:'data:audio/mp4;base64,AAAAHGZ0eXBpc29t', title:'t', showName:'s', positionSec:0, durationSec:100}});
      // 璁℃暟妗╋細鍖呬竴灞?togglePlayerPlay 璁拌处
      const st=s.getState();
      if(!window.__probe){
        window.__probe={calls:0};
        const orig=st.togglePlayerPlay;
        s.setState({togglePlayerPlay:(...a)=>{ window.__probe.calls++; return orig(...a); }});
      }
      window.__probe.calls=0;
      return {ok:true, isActive:s.getState().player.isActive};
    }catch(e){return{ok:false,err:String(e&&e.message||e).slice(0,180)};}
  })()`);
  console.log('娉ㄥ叆:', JSON.stringify(inj));
  await sleep(1200);

  const dom = await cdp.eval(`(()=>({cards:document.querySelectorAll('[data-card-index]').length,
    tabbable:[...document.querySelectorAll('[data-card-index]')].filter(c=>c.tabIndex===0).length}))()`);
  console.log('鍗＄墖:', JSON.stringify(dom));

  const reset = async () => { await cdp.eval(`window.__probe.calls=0; true`); };
  const calls = async () => await cdp.eval(`window.__probe.calls`);
  const state = async () => await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore.getState();
    return {activeArticleId:s.activeArticleId, isPlaying:s.player.isPlaying};})()`);

  console.log('\n=== A) 鐒︾偣鍦?article-card 鏃舵寜 Space锛堝簲鍙紑鏂囩珷銆佷笉鍒囨挱鏀撅級===');
  await cdp.eval(`document.querySelector('[data-card-index]')?.focus(); true`);
  await sleep(300);
  await reset();
  const before = await state();
  await cdp.keyRaw(' ','Space',32);
  await sleep(700);
  const afterA = await state();
  const callsA = await calls();
  console.log(`  before: ${JSON.stringify(before)}`);
  console.log(`  after : ${JSON.stringify(afterA)}`);
  console.log(`  togglePlayerPlay 璋冪敤娆℃暟 = ${callsA}   (鏈熸湜 0)`);
  console.log(`  鍗＄墖鍔ㄤ綔鏄惁鍙戠敓 = ${before.activeArticleId !== afterA.activeArticleId}  (鏈熸湜 true)`);

  console.log('\n=== B) 瀵圭収锛氱劍鐐瑰湪 body锛堥潪鑷畾涔夋帶浠讹級鎸?Space锛堝簲鍒囨挱鏀撅級===');
  await cdp.eval(`document.activeElement?.blur(); document.body.focus?.(); true`);
  await sleep(300);
  await reset();
  const beforeB = await state();
  await cdp.keyRaw(' ','Space',32);
  await sleep(700);
  const afterB = await state();
  const callsB = await calls();
  console.log(`  togglePlayerPlay 璋冪敤娆℃暟 = ${callsB}   (鏈熸湜 鈮?)`);
  console.log(`  isPlaying: ${beforeB.isPlaying} -> ${afterB.isPlaying}`);

  console.log('\n=== C) 瀵圭収锛欵nter 涓嶅簲鍙楀奖鍝嶏紙鍗＄墖浠嶈兘鎵撳紑锛?==');
  await cdp.eval(`document.querySelector('[data-card-index]')?.focus(); true`);
  await sleep(250);
  await reset();
  const beforeC = await state();
  await cdp.keyRaw('Enter','Enter',13);
  await sleep(600);
  const callsC = await calls();
  const afterC = await state();
  console.log(`  togglePlayerPlay=${callsC}锛堟湡鏈?0锛? 鍗＄墖鍔ㄤ綔=${beforeC.activeArticleId !== afterC.activeArticleId}`);

  console.log('\n=== 姹囨€诲垽瀹?===');
  const pass = callsA === 0 && (before.activeArticleId !== afterA.activeArticleId) && callsB >= 1 && callsC === 0;
  console.log(`  A(鏃犲弻閲嶅姩浣?=${callsA===0}  A(鎺т欢浠嶇敓鏁?=${before.activeArticleId!==afterA.activeArticleId}  B(Space浠嶈兘鎾斁)=${callsB>=1}  C(Enter涓嶅彈褰卞搷)=${callsC===0}`);
  console.log(`  => Space 鍙岄噸鍔ㄤ綔淇: ${pass ? '鉁?鎴愮珛' : '鉂?涓嶆垚绔?}`);

  cdp.sock.end(); await sleep(300);
  try{ child.kill(); }catch{}
  await sleep(900);
  try{ fs.rmSync(PROFILE,{recursive:true,force:true}); console.log('涓存椂 profile 宸插垹闄?); }catch{}
  console.log('DONE');
};
main().catch(e=>{ console.error('FAILED:', e.message); process.exit(1); });

