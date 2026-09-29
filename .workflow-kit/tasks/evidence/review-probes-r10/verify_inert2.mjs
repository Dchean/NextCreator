// TASK-047 验证（修正版）：用稳定元素身份做 Tab 遍历计数，避免「同类名连续停靠被误判为循环」。
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
    if(r.result?.exceptionDetails) return {__err:(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text||'').slice(0,200)};
    return r.result?.result?.value; }
  async key(key,code,vk){ await this.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk}); }
  async shot(p){ const r=await this.send('Page.captureScreenshot',{format:'png'}); if(!r.result?.data)return false;
    fs.writeFileSync(p,Buffer.from(r.result.data,'base64')); return true; }
}

const R = [];
const log = (s) => { console.log(s); R.push(s); };

const PROBE = `(()=>{const e=document.activeElement; if(!e) return null;
  if(!e.__dshProbe) e.__dshProbe = 'p' + (window.__dshProbeN = (window.__dshProbeN||0)+1);
  const ov = e.closest('.modal-overlay');
  return {id:e.__dshProbe, tag:e.tagName, cls:String(e.className||'').slice(0,30),
          inOverlay: !!ov, ovClass: ov ? String(ov.className).slice(0,30) : null,
          inertAncestor: !!e.closest('[inert]'),
          fv: e.matches(':focus-visible')};})()`;

// 完整走一圈：直到回到首个停靠点（真循环）或达到上限
const walk = async (cdp, cap=80) => {
  await cdp.eval(`document.activeElement?.blur(); document.body.focus?.(); window.__dshProbeN=0; true`);
  await sleep(150);
  const stops = []; let first = null;
  for (let i=0;i<cap;i++){
    await cdp.key('Tab','Tab',9); await sleep(40);
    const c = await cdp.eval(PROBE);
    if (!c || c.__err) break;
    if (first === null) first = c.id;
    else if (c.id === first) { stops.push({...c, cycled:true}); break; }   // 回到起点 = 完整一圈
    stops.push(c);
  }
  return stops;
};

const overlays = (cdp) => cdp.eval(`(()=>[...document.querySelectorAll('.modal-overlay')].map(el=>({
  cls:String(el.className).slice(0,44), open:el.classList.contains('open'), inert:el.hasAttribute('inert'),
  ariaHidden:el.getAttribute('aria-hidden'),
  tabbable:[...el.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(n=>n.tabIndex>=0&&!n.disabled).length})))()`);

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const cdp = new CDP(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await sleep(1200);

  log('注入 mock: ' + JSON.stringify(await cdp.eval(`(async()=>{try{
    const s=(await import('/src/store.ts')).useAppStore;
    const mk=await import('/src/mockData.ts');
    const cats=mk.createInitialCategories(), entries=mk.createInitialEntries();
    const fi=new Map(); for(const c of cats) for(const f of c.feeds) fi.set(f.id,{feed:f,cat:c});
    s.setState({dataMode:'mock',dataLoading:false,categories:cats,feedIndex:fi,entries,
      activeContentLayout:'article',activeViewFilter:'all',activeFeedFilter:'all',timelineFilter:'all',
      settingsOpen:false,searchOpen:false,activeArticleId:null,lightboxUrl:null});
    return {ok:true};}catch(e){return{ok:false,err:String(e&&e.message||e).slice(0,150)};}})()`)));
  await sleep(1200);

  // ---- 1) 全关：Tab 不得进入任何浮层 ----
  log('\n=== 1) 默认（全部浮层关闭）Tab 遍历 ===');
  for (const o of await overlays(cdp)) log(`   浮层 ${o.cls}  open=${o.open} inert=${o.inert} aria-hidden=${o.ariaHidden} 内部名义可Tab=${o.tabbable}`);
  const s1 = await walk(cdp);
  const bad1 = s1.filter(s=>s.inOverlay);
  log(`   Tab 停靠点 ${s1.length} 个（走满一圈）；位于浮层内 ${bad1.length} 个  => ${bad1.length===0?'✓ 成立':'❌ 失败'}`);
  log(`   停靠点: ${s1.map(s=>s.tag+'.'+s.cls.split(' ')[0]).join(' → ')}`);
  log(`   其中 :focus-visible=true 的 ${s1.filter(s=>s.fv).length}/${s1.length}`);
  await cdp.shot(EV + 'TASK-047-01-closed-no-overlay-focus.png');

  // ---- 2) 打开设置：内部可 Tab 进入且有焦点环 ----
  log('\n=== 2) 设置弹窗打开 ===');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().openSettings(); return true;})()`);
  await sleep(800);
  const ov2 = await overlays(cdp);
  const openOv = ov2.find(o=>o.open);
  log(`   打开中的浮层: open=${openOv.open} inert=${openOv.inert} 内部可Tab=${openOv.tabbable}`);
  const s2 = await walk(cdp, 30);
  const in2 = s2.filter(s=>s.inOverlay);
  log(`   Tab 停靠点 ${s2.length}；位于浮层内 ${in2.length} 个  => 可进入: ${in2.length>0?'✓':'❌'}`);
  log(`   浮层内带 :focus-visible 的 ${in2.filter(s=>s.fv).length} 个  => 焦点环可见: ${in2.some(s=>s.fv)?'✓':'❌'}`);
  await cdp.shot(EV + 'TASK-047-02-settings-open-focus-ring.png');

  // ---- 3) 关闭设置：焦点离开 + 不可再 Tab ----
  log('\n=== 3) 设置弹窗关闭 ===');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().closeSettings(); return true;})()`);
  await sleep(800);
  const a3 = await cdp.eval(`(()=>{const e=document.activeElement; return {tag:e?e.tagName:null,
    inOverlay:!!(e&&e.closest('.modal-overlay')), inertAncestor:!!(e&&e.closest('[inert]'))};})()`);
  log(`   activeElement: ${JSON.stringify(a3)}  => 不在 inert 子树内: ${a3.inertAncestor===false?'✓':'❌'}`);
  const s3 = await walk(cdp);
  const in3 = s3.filter(s=>s.inOverlay);
  log(`   关闭后 Tab 停靠点 ${s3.length}；位于浮层内 ${in3.length}  ${in3.length===0?'✓':'❌'}`);

  // ---- 4) 命令面板 ----
  log('\n=== 4) 命令面板（搜索） ===');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().openSearch(); return true;})()`);
  await sleep(700);
  const s4a = await walk(cdp, 25);
  log(`   打开: 停靠点 ${s4a.length}，浮层内 ${s4a.filter(s=>s.inOverlay).length}`);
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().closeSearch(); return true;})()`);
  await sleep(700);
  const s4b = await walk(cdp);
  const in4 = s4b.filter(s=>s.inOverlay);
  log(`   关闭: 停靠点 ${s4b.length}，浮层内 ${in4.length}  ${in4.length===0?'✓':'❌'}`);

  // ---- 5) 灯箱 ----
  log('\n=== 5) 灯箱 ===');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore;
    s.setState({lightboxUrl:'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MCIgaGVpZ2h0PSI4MCI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjMjQ0Ii8+PC9zdmc+'});
    return true;})()`);
  await sleep(700);
  const lb1 = await cdp.eval(`(()=>{const e=document.querySelector('.lightbox-overlay');
    return e?{open:e.classList.contains('open'),inert:e.hasAttribute('inert'),inertAnc:!!e.closest('[inert]')}:null;})()`);
  log(`   打开: ${JSON.stringify(lb1)}`);
  await cdp.shot(EV + 'TASK-047-03-lightbox-open.png');
  await cdp.key('Escape','Escape',27);
  await sleep(700);
  const lb2 = await cdp.eval(`(()=>{const e=document.querySelector('.lightbox-overlay');
    return e?{open:e.classList.contains('open'),inert:e.hasAttribute('inert')}:null;})()`);
  log(`   Esc 后: ${JSON.stringify(lb2)}  => 可关闭 ${lb2&&!lb2.open?'✓':'❌'}；关闭后 inert ${lb2&&lb2.inert?'✓':'❌'}`);
  const s5 = await walk(cdp);
  log(`   关闭后 Tab 位于浮层内 ${s5.filter(s=>s.inOverlay).length}  ${s5.filter(s=>s.inOverlay).length===0?'✓':'❌'}`);

  // ---- 6) 条件渲染的两个浮层（预期本就通过） ----
  log('\n=== 6) 右键菜单 / 确认框（条件渲染） ===');
  const c6 = await cdp.eval(`(()=>({ctx:!!document.querySelector('.ctx-menu'), confirm:!!document.querySelector('.confirm-overlay')}))()`);
  log(`   关闭态 DOM 中存在: ${JSON.stringify(c6)}  => 右键菜单 ${c6.ctx===false?'✓ 不在 DOM':'❌'}；确认框 ${c6.confirm===false?'✓ 不在 DOM':'❌'}`);

  fs.writeFileSync(EV + 'TASK-047-verify-log.txt', R.join('\n') + '\n', 'utf8');
  cdp.sock.end(); console.log('\nDONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
