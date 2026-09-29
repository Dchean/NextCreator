// TASK-050 实机冒烟：SettingsModal 拆分后是否仍能渲染与交互。
// 经 CDP 驱动真实 WebView2；不注入系统级键鼠、不抢焦点。
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
    if(r.result?.exceptionDetails) return {__err:(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text||'').slice(0,200)};
    return r.result?.result?.value; }
  async shot(p){ const r=await this.send('Page.captureScreenshot',{format:'png'}); if(!r.result?.data)return false;
    fs.writeFileSync(p,Buffer.from(r.result.data,'base64')); return true; }
}

const R = [];
const log = (s) => { console.log(s); R.push(s); };

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const cdp = new CDP(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Page.enable');
  await sleep(1500);
  log('# TASK-050 实机冒烟：SettingsModal 拆分后渲染与交互');
  log('# 环境：真实 Tauri WebView2 + CDP；未注入系统级键鼠、未抢占窗口焦点');
  log('');

  // 注入内存 mock（不写库）
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

  const errBefore = cdp.events.length;

  // 打开设置
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().openSettings(); return true;})()`);
  await sleep(1000);
  const opened = await cdp.eval(`(()=>{const o=[...document.querySelectorAll('.modal-overlay')].find(e=>e.classList.contains('open'));
    const nav=[...document.querySelectorAll('.settings-nav-item')].map(n=>n.textContent.trim());
    return {open:!!o, inert:o?o.hasAttribute('inert'):null, navCount:nav.length, nav};})()`);
  log(`\n## 打开设置：${JSON.stringify(opened)}`);
  log(`   标签页数 ${opened.navCount}  => ${opened.open && opened.navCount===8 ? '✓ 8 个标签页' : '⚠ 数量异常'}`);

  // 逐个标签页切换
  log('\n## 逐标签页切换');
  const tabs = opened.nav;
  const results = [];
  for (let i = 0; i < tabs.length; i++) {
    const r = await cdp.eval(`(async()=>{
      const items=[...document.querySelectorAll('.settings-nav-item')];
      const el=items[${i}];
      if(!el) return {ok:false, why:'未找到导航项'};
      el.click();
      await new Promise(r=>setTimeout(r,260));
      const b=document.querySelector('.modal-card') || document.body;
      const txt=(b.innerText||'').replace(/\\s+/g,' ').trim();
      return {ok:true, label:el.textContent.trim(), len:txt.length, head:txt.slice(0,90)};})()`);
    results.push(r);
    log(`   [${i+1}/${tabs.length}] ${String(r.label||'').padEnd(8)} 内容长度=${String(r.len).padStart(5)}  ${r.len>40?'✓':r.ok===true?'⚠ 内容偏少':'✗ '+r.what}`);
  }
  const thin = results.filter(r=>!r.ok || r.len<=40);
  log(`   => 全部标签页渲染出内容：${thin.length===0 ? '✓ 成立' : '✗ 有 ' + thin.length + ' 页异常'}`);
  await cdp.shot(EV + 'TASK-050-01-settings-first-tab.png');

  // 交互 1：切到「通用」并切换一个开关
  log('\n## 交互验证');
  const inter1 = await cdp.eval(`(async()=>{
    document.querySelectorAll('.settings-nav-item')[0]?.click();
    await new Promise(r=>setTimeout(r,300));
    const s=(await import('/src/store.ts')).useAppStore;
    const before=JSON.stringify(s.getState().settings.autoRefresh ?? null);
    const sw=document.querySelector('.switch-control input');
    if(!sw) return {ok:false, why:'未找到开关'};
    sw.click();
    await new Promise(r=>setTimeout(r,300));
    const after=JSON.stringify(s.getState().settings.autoRefresh ?? null);
    return {ok:true, before, after, changed: before!==after};})()`);
  log(`   开关点击：${JSON.stringify(inter1)}`);

  // 交互 2：切到「外观」并改一个下拉值（FluxDropdown）
  const inter2 = await cdp.eval(`(async()=>{
    document.querySelectorAll('.settings-nav-item')[1]?.click();
    await new Promise(r=>setTimeout(r,320));
    const t=document.querySelector('.flux-dropdown-trigger');
    if(!t) return {ok:false, why:'该页无 FluxDropdown'};
    t.click();
    await new Promise(r=>setTimeout(r,260));
    const opts=[...document.querySelectorAll('.flux-dropdown-option')];
    if(!opts.length) return {ok:false, why:'下拉未展开'};
    const labelBefore=t.textContent.trim();
    opts[opts.length-1].click();
    await new Promise(r=>setTimeout(r,320));
    const labelAfter=document.querySelector('.flux-dropdown-trigger')?.textContent.trim();
    return {ok:true, labelBefore, labelAfter, changed: labelBefore!==labelAfter, optCount:opts.length};})()`);
  log(`   下拉选择：${JSON.stringify(inter2)}`);
  await cdp.shot(EV + 'TASK-050-02-settings-interaction.png');

  // 关闭并复查
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().closeSettings(); return true;})()`);
  await sleep(700);
  const closed = await cdp.eval(`(()=>{const o=[...document.querySelectorAll('.modal-overlay')].find(e=>String(e.className).includes('modal-overlay'));
    return {open:[...document.querySelectorAll('.modal-overlay')].some(e=>e.classList.contains('open'))};})()`);
  log(`\n## 关闭后：${JSON.stringify(closed)}  => ${closed.open===false?'✓ 已关闭':'✗'}`);

  // console 错误
  const errs = cdp.events.filter(e =>
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Runtime.consoleAPICalled' && ['error','warning'].includes(e.params?.type)) ||
    (e.method === 'Log.entryAdded' && ['error'].includes(e.params?.entry?.level)));
  log(`\n## console 错误/异常：${errs.length} 条`);
  for (const e of errs.slice(0, 8)) {
    const d = e.params?.exceptionDetails?.exception?.description
      || (e.params?.args || []).map(a=>a.value ?? a.description).join(' ')
      || e.params?.entry?.text || '';
    log('   - ' + String(d).slice(0, 160));
  }

  log('\n## 判定');
  const pass = opened.open && opened.navCount === 8 && thin.length === 0 && errs.length === 0 && closed.open === false;
  log(`   8 标签页全渲染: ${thin.length===0}`); 
  log(`   无 console 错误: ${errs.length===0}`);
  log(`   开关交互生效: ${inter1.changed === true}`);
  log(`   下拉交互生效: ${inter2.changed === true}`);
  log(`   => 冒烟${pass ? ' ✓ 通过' : ' ⚠ 见上'}`);

  fs.writeFileSync(EV + 'TASK-050-smoke-log.txt', R.join('\n') + '\n', { encoding: 'utf8' });
  cdp.sock.end(); console.log('\nDONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
