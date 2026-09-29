// TASK-047 验证：关闭态浮层不可聚焦（inert）。
// 全部经 CDP 驱动真实 WebView2：真实 Tab 遍历 + 真实截图，不注入系统级键鼠。
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

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const page = list.find(t=>t.type==='page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await sleep(1500);

  // 注入内存 mock（不写库），使界面有内容
  const inj = await cdp.eval(`(async()=>{try{
    const s=(await import('/src/store.ts')).useAppStore;
    const mk=await import('/src/mockData.ts');
    const cats=mk.createInitialCategories(), entries=mk.createInitialEntries();
    const fi=new Map(); for(const c of cats) for(const f of c.feeds) fi.set(f.id,{feed:f,cat:c});
    s.setState({dataMode:'mock',dataLoading:false,categories:cats,feedIndex:fi,entries,
      activeContentLayout:'article',activeViewFilter:'all',activeFeedFilter:'all',timelineFilter:'all',
      settingsOpen:false,searchOpen:false,activeArticleId:null,lightboxUrl:null});
    return {ok:true};}catch(e){return{ok:false,err:String(e&&e.message||e).slice(0,150)};}})()`);
  log('注入 mock: ' + JSON.stringify(inj));
  await sleep(1200);

  // ---------- 观察工具 ----------
  const overlayState = () => cdp.eval(`(()=>{
    const out=[];
    for (const el of document.querySelectorAll('.modal-overlay')) {
      out.push({cls:el.className, inert: el.hasAttribute('inert'), ariaHidden: el.getAttribute('aria-hidden'),
                open: el.classList.contains('open'),
                tabbable: [...el.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')]
                  .filter(n=>n.tabIndex>=0 && !n.disabled).length});
    }
    return out;})()`);

  const walkTab = async (max) => {
    const stops=[];
    await cdp.eval(`document.activeElement?.blur(); document.body.focus?.(); true`);
    await sleep(150);
    for (let i=0;i<max;i++){
      await cdp.key('Tab','Tab',9); await sleep(45);
      const cur = await cdp.eval(`(()=>{const e=document.activeElement; if(!e) return null;
        return {tag:e.tagName, cls:(e.className||'').toString().slice(0,34),
                inOverlay: !!e.closest('.modal-overlay'),
                overlayCls: e.closest('.modal-overlay')?.className || null,
                fv: e.matches(':focus-visible')};})()`);
      if (!cur) break;
      const key = cur.tag + '|' + cur.cls;
      if (stops.length && stops[stops.length-1].key === key && i > 3) break;
      stops.push({...cur, key});
    }
    return stops;
  };

  // ---------- 1) 默认全关：Tab 遍历不得进入浮层 ----------
  log('\n=== 1) 默认（全关）Tab 遍历 ===');
  const ov0 = await overlayState();
  for (const o of ov0) log(`   浮层 ${String(o.cls).slice(0,40)}  open=${o.open} inert=${o.inert} aria-hidden=${o.ariaHidden} 内部可Tab=${o.tabbable}`);
  const stops0 = await walkTab(40);
  const inside0 = stops0.filter(s=>s.inOverlay);
  log(`   Tab 停靠点 ${stops0.length} 个；其中位于浮层内: ${inside0.length}  ${inside0.length===0?'✓ 成立':'❌ 失败'}`);
  if (inside0.length) for (const s of inside0.slice(0,5)) log(`      ❌ ${s.tag}.${s.cls} @ ${s.overlayCls}`);
  log('   停靠点序列: ' + stops0.map(s=>s.tag).join(' → ').slice(0,220));
  await cdp.shot(EV + 'TASK-047-01-closed-tab-walk.png');

  // ---------- 2) 打开设置：控件可进入且有焦点环 ----------
  log('\n=== 2) 打开设置弹窗：内部控件可 Tab 进入 ===');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().openSettings(); return true;})()`);
  await sleep(700);
  const ov1 = await overlayState();
  for (const o of ov1) log(`   浮层 ${String(o.cls).slice(0,40)}  open=${o.open} inert=${o.inert} 内部可Tab=${o.tabbable}`);
  const stops1 = await walkTab(40);
  const inSet = stops1.filter(s=>s.inOverlay);
  log(`   Tab 停靠点 ${stops1.length}；其中在浮层内 ${inSet.length} 个，带 :focus-visible 的 ${inSet.filter(s=>s.fv).length} 个`);
  log(`   => 打开态可进入: ${inSet.length>0?'✓':'❌'}；焦点环可见: ${inSet.some(s=>s.fv)?'✓':'❌'}`);
  await cdp.shot(EV + 'TASK-047-02-settings-open-focus.png');

  // ---------- 3) 关闭后焦点不得留在 inert 子树内 ----------
  log('\n=== 3) 关闭设置弹窗：焦点与可聚焦性 ===');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().closeSettings(); return true;})()`);
  await sleep(700);
  const after = await cdp.eval(`(()=>{const e=document.activeElement;
    return {tag:e?e.tagName:null, inOverlay: !!(e&&e.closest('.modal-overlay')), inertAncestor: !!(e&&e.closest('[inert]'))};})()`);
  const ov2 = await overlayState();
  const setOv = ov2.find(o=>String(o.cls).includes('modal-overlay') && !o.open) || ov2[0];
  log(`   activeElement: ${JSON.stringify(after)}`);
  log(`   => 焦点不在 inert 子树内: ${after.inertAncestor===false ? '✓' : '❌'}`);
  const stops2 = await walkTab(40);
  const inside2 = stops2.filter(s=>s.inOverlay);
  log(`   关闭后 Tab 停靠点 ${stops2.length}；位于浮层内 ${inside2.length}  ${inside2.length===0?'✓':'❌'}`);

  // ---------- 4) 命令面板 ----------
  log('\n=== 4) 命令面板（搜索）开/关 ===');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().openSearch(); return true;})()`);
  await sleep(600);
  const s4a = await walkTab(30);
  log(`   打开时: 停靠点 ${s4a.length}，浮层内 ${s4a.filter(s=>s.inOverlay).length}`);
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().closeSearch(); return true;})()`);
  await sleep(600);
  const s4b = await walkTab(30);
  const in4 = s4b.filter(s=>s.inOverlay);
  log(`   关闭后: 停靠点 ${s4b.length}，浮层内 ${in4.length}  ${in4.length===0?'✓':'❌'}`);

  // ---------- 5) 灯箱 Esc 关闭 + 关闭后不可 Tab ----------
  log('\n=== 5) 灯箱 ===');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore;
    s.setState({lightboxUrl:'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MCIgaGVpZ2h0PSI4MCI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjMjQ0Ii8+PC9zdmc+'});
    return true;})()`);
  await sleep(600);
  const lb1 = await cdp.eval(`(()=>{const el=document.querySelector('.lightbox-overlay');
    return el?{open:el.classList.contains('open'), inert:el.hasAttribute('inert')}:null;})()`);
  log(`   打开: ${JSON.stringify(lb1)}`);
  await cdp.key('Escape','Escape',27);
  await sleep(600);
  const lb2 = await cdp.eval(`(()=>{const el=document.querySelector('.lightbox-overlay');
    const s=window.__dshStoreProbe; return el?{open:el.classList.contains('open'), inert:el.hasAttribute('inert')}:null;})()`);
  log(`   Esc 后: ${JSON.stringify(lb2)}  => Esc 可关闭: ${lb2 && !lb2.open ? '✓':'❌'}；关闭后 inert: ${lb2 && lb2.inert ? '✓':'❌'}`);

  // ---------- 6) 右键菜单（条件渲染，应本就通过） ----------
  log('\n=== 6) 右键菜单（条件渲染，预期本就通过）===');
  const ctx = await cdp.eval(`(()=>({ctxMenuInDom: !!document.querySelector('.ctx-menu'),
    confirmInDom: !!document.querySelector('.confirm-overlay')}))()`);
  log(`   关闭态 DOM 中: ${JSON.stringify(ctx)}  => 右键菜单不在 DOM: ${ctx.ctxMenuInDom===false?'✓':'❌'}；确认框不在 DOM: ${ctx.confirmInDom===false?'✓':'❌'}`);

  fs.writeFileSync(EV + 'TASK-047-verify-log.txt', R.join('\n') + '\n', 'utf8');
  cdp.sock.end();
  console.log('\nDONE');
};
main().catch(e=>{ console.error('FAILED:', e.message); process.exit(1); });
