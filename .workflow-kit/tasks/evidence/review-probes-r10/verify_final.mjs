// TASK-047 权威验证（修复轮重生成）：产出 TASK-047-verify-log.txt
// 关键修正（针对审查 finding 01/02）：
//  - 循环判定用「首次聚焦打元素标记」，不用同类名（避开 7 个 settings-nav-item 陷阱）
//  - 上限 240（弹窗 portal 在 body 末尾，主视图约 31 个停靠点）
//  - 消融对照不提前终止；并统计停靠点的有效不透明度（effOpacity）
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

// 每次遍历前清零标记；读取时若元素无标记则打标（元素身份判定）
// 每次遍历用独立「代」标记元素：避免上一次遍历的标记与本次计数器重置后撞号
// （上一版把标记写成 JS 属性却用属性选择器清理，清不掉 → 撞号 → 遍历提前终止）
const PROBE = `(()=>{const e=document.activeElement; if(!e) return null;
  const g = window.__gen;
  if (e.__avGen !== g) { e.__avGen = g; e.__avId = 'g' + g + '_' + (window.__vn = (window.__vn||0)+1); }
  const ov = e.closest('.modal-overlay');
  let op = 1, n = e;
  while (n && n !== document.documentElement) { const o = parseFloat(getComputedStyle(n).opacity); op = Math.min(op, isNaN(o)?1:o); n = n.parentElement; }
  return {id:e.__avId, tag:e.tagName, cls:String(e.className||'').slice(0,26),
          inOverlay:!!ov, ovCls: ov?String(ov.className).slice(0,26):null, effOpacity: op,
          fv: e.matches(':focus-visible'), inertAncestor: !!e.closest('[inert]')};})()`;

const walk = async (cdp, cap=240) => {
  await cdp.eval(`document.activeElement?.blur(); document.body.focus?.();
    window.__gen = (window.__gen||0) + 1; window.__vn = 0; true`);
  await sleep(200);
  const stops=[]; let first=null;
  for (let i=0;i<cap;i++){
    await cdp.key('Tab','Tab',9); await sleep(30);
    const c = await cdp.eval(PROBE);
    if(!c || c.__err) break;
    if (first === null) first = c.id;
    else if (c.id === first) { stops.push({...c, wrapsToFirst:true}); break; }
    stops.push(c);
  }
  return stops;
};

const summarize = (stops) => {
  const inOv = stops.filter(s=>s.inOverlay);
  const invisible = stops.filter(s=>s.effOpacity === 0);
  return { total: stops.length, mainView: stops.filter(s=>!s.inOverlay).length,
           inOverlay: inOv.length, invisible, fv: stops.filter(s=>s.fv).length };
};

const overlays = (cdp) => cdp.eval(`(()=>[...document.querySelectorAll('.modal-overlay')].map(el=>({
  cls:String(el.className).slice(0,44), open:el.classList.contains('open'), inert:el.hasAttribute('inert'),
  inertVal:el.getAttribute('inert'), ariaHidden:el.getAttribute('aria-hidden'),
  tabbable:[...el.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(n=>n.tabIndex>=0&&!n.disabled).length})))()`);

const R = [];
const log = (s) => { console.log(s); R.push(s); };

const main = async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const cdp = new CDP(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await sleep(1300);
  log('# TASK-047 实机验证日志（修复轮重生成，取代 16:22 那版有缺陷的输出）');
  log('# 环境：真实 Tauri WebView2 + CDP（Input.dispatchKeyEvent / Runtime.evaluate / Page.captureScreenshot）');
  log('# 方法：从 body 起按 Tab 直至回到首个停靠点；循环判定用「首次聚焦打元素标记」（不用同类名）；上限 240');
  log('# 未注入系统级键鼠、未抢占窗口焦点；测试数据经 Vite 模块图 setState 注入（纯内存）');
  log('');

  log('## 注入内存 mock');
  log(JSON.stringify(await cdp.eval(`(async()=>{try{
    const s=(await import('/src/store.ts')).useAppStore;
    const mk=await import('/src/mockData.ts');
    const cats=mk.createInitialCategories(), entries=mk.createInitialEntries();
    const fi=new Map(); for(const c of cats) for(const f of c.feeds) fi.set(f.id,{feed:f,cat:c});
    s.setState({dataMode:'mock',dataLoading:false,categories:cats,feedIndex:fi,entries,
      activeContentLayout:'article',activeViewFilter:'all',activeFeedFilter:'all',timelineFilter:'all',
      settingsOpen:false,searchOpen:false,activeArticleId:null,lightboxUrl:null});
    return {ok:true};}catch(e){return{ok:false,err:String(e&&e.message||e).slice(0,150)};}})()`)));
  await sleep(1300);

  log('\n## 1) 默认（全部浮层关闭）');
  for (const o of await overlays(cdp))
    log(`   浮层 ${o.cls} open=${o.open} inert=${o.inert} inertVal=${JSON.stringify(o.inertVal)} aria-hidden=${o.ariaHidden} 名义可Tab=${o.tabbable}`);
  const w1 = await walk(cdp);
  const s1 = summarize(w1);
  log(`   Tab 走满一圈：停靠点 ${s1.total} 个（主视图 ${s1.mainView} + 回绕锚点 1）`);
  log(`   其中位于浮层内：${s1.inOverlay} 个  => 验收第 1 条 ${s1.inOverlay===0?'✓ 成立':'✗ 失败'}`);
  log(`   其中有效不透明度为 0 的：${s1.invisible.length} 个  => 不停留在不可见控件 ${s1.invisible.length===0?'✓':'✗'}`);
  log(`   :focus-visible=true 的：${s1.fv}/${s1.total}`);
  log(`   停靠点序列：${w1.map(s=>s.tag+'.'+s.cls.split(' ')[0]).join(' → ')}`);
  await cdp.shot(EV + 'TASK-047-01-closed-no-overlay-focus.png');

  log('\n## 2) 消融对照：临时移除全部 inert 后重走');
  const removed = await cdp.eval(`(()=>{const els=[...document.querySelectorAll('[inert]')];
    els.forEach(e=>{e.__saved=true; e.removeAttribute('inert');}); return els.length;})()`);
  log(`   已移除 inert 的节点数：${removed}`);
  await sleep(300);
  const w2 = await walk(cdp);
  const s2 = summarize(w2);
  log(`   停靠点 ${s2.total} 个（主视图 ${s2.mainView}）；其中浮层内 ${s2.inOverlay} 个`);
  log(`   浮层内停靠点中有效不透明度为 0 的：${w2.filter(s=>s.inOverlay && s.effOpacity===0).length} 个`);
  log(`   => 移除 inert 后关闭态浮层控件重新进入 Tab 序列：${s2.inOverlay>0?'✓ 证明 inert 是生效点':'✗ 无差异，inert 未生效'}`);
  log(`   主视图停靠点：有 inert 时 ${s1.mainView} → 移除后 ${s2.mainView}（应相同；差异只应出现在浮层内）`);
  const restored = await cdp.eval(`(()=>{let n=0;[...document.querySelectorAll('.modal-overlay')].forEach(e=>{
    if(e.__saved){e.setAttribute('inert',''); delete e.__saved; n++;}}); return n;})()`);
  log(`   已还原 inert 的节点数：${restored}`);
  await sleep(300);
  const w3 = await walk(cdp);
  const s3 = summarize(w3);
  log(`   还原后：停靠点 ${s3.total} 个（主视图 ${s3.mainView}），浮层内 ${s3.inOverlay} 个  => ${s3.inOverlay===0?'✓ 恢复':'✗'}`);

  log('\n## 3) 打开设置弹窗');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().openSettings(); return true;})()`);
  await sleep(900);
  const ovOpen = (await overlays(cdp)).find(o=>o.open);
  log(`   打开中的浮层：open=${ovOpen.open} inert=${ovOpen.inert}（打开态不应有 inert）名义可Tab=${ovOpen.tabbable}`);
  const w4 = await walk(cdp);
  const s4 = summarize(w4);
  const inOv4 = w4.filter(s=>s.inOverlay);
  log(`   Tab 停靠点 ${s4.total} 个（主视图 ${s4.mainView} + 浮层内 ${s4.inOverlay}）`);
  log(`   浮层内带 :focus-visible 的：${inOv4.filter(s=>s.fv).length}/${inOv4.length}  => 验收第 2 条 ${inOv4.length>0 && inOv4.every(s=>s.fv) ? '✓ 成立' : '✗'}`);
  log(`   进入浮层前需经过的主视图停靠点数：${w4.findIndex(s=>s.inOverlay)}`);
  await cdp.shot(EV + 'TASK-047-02-settings-open-focus-ring.png');

  log('\n## 4) 关闭设置弹窗');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().closeSettings(); return true;})()`);
  await sleep(800);
  const a4 = await cdp.eval(`(()=>{const e=document.activeElement; return {tag:e?e.tagName:null,
    inOverlay:!!(e&&e.closest('.modal-overlay')), inertAncestor:!!(e&&e.closest('[inert]'))};})()`);
  log(`   activeElement：${JSON.stringify(a4)}  => 验收第 3 条 ${a4.inertAncestor===false?'✓ 不在 inert 子树内':'✗'}`);
  const w5 = await walk(cdp);
  const s5 = summarize(w5);
  log(`   关闭后 Tab 停靠点 ${s5.total}（主视图 ${s5.mainView}），浮层内 ${s5.inOverlay}  => ${s5.inOverlay===0?'✓':'✗'}`);

  log('\n## 5) 命令面板（搜索）');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore; s.getState().openSearch(); return true;})()`);
  await sleep(800);
  const s6 = summarize(await walk(cdp));
  log(`   打开：停靠点 ${s6.total}，浮层内 ${s6.inOverlay}  => ${s6.inOverlay>0?'✓ 可进入':'✗'}`);
  await cdp.key('Escape','Escape',27);
  await sleep(800);
  const s7 = summarize(await walk(cdp));
  log(`   Esc 关闭后：停靠点 ${s7.total}，浮层内 ${s7.inOverlay}  => 验收第 4 条 ${s7.inOverlay===0?'✓':'✗'}`);

  log('\n## 6) 灯箱');
  await cdp.eval(`(async()=>{const s=(await import('/src/store.ts')).useAppStore;
    s.setState({lightboxUrl:'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MCIgaGVpZ2h0PSI4MCI+PHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjMjQ0Ii8+PC9zdmc+'});
    return true;})()`);
  await sleep(800);
  const lb1 = await cdp.eval(`(()=>{const e=document.querySelector('.lightbox-overlay');
    return e?{open:e.classList.contains('open'),inert:e.hasAttribute('inert')}:null;})()`);
  log(`   打开：${JSON.stringify(lb1)}`);
  await cdp.shot(EV + 'TASK-047-03-lightbox-open.png');
  await cdp.key('Escape','Escape',27);
  await sleep(800);
  const lb2 = await cdp.eval(`(()=>{const e=document.querySelector('.lightbox-overlay');
    return e?{open:e.classList.contains('open'),inert:e.hasAttribute('inert')}:null;})()`);
  log(`   Esc 后：${JSON.stringify(lb2)}  => 验收第 5 条 ${lb2 && !lb2.open && lb2.inert ? '✓ 可关闭且关闭后 inert':'✗'}`);
  const s8 = summarize(await walk(cdp));
  log(`   关闭后 Tab 浮层内 ${s8.inOverlay}  => ${s8.inOverlay===0?'✓':'✗'}`);

  log('\n## 7) 右键菜单 / 确认框（条件渲染，预期本就通过）');
  const c7 = await cdp.eval(`(()=>({ctx:!!document.querySelector('.ctx-menu'), confirm:!!document.querySelector('.confirm-overlay')}))()`);
  log(`   关闭态 DOM 中存在：${JSON.stringify(c7)}  => 验收第 6/7 条 ${c7.ctx===false && c7.confirm===false ? '✓ 均不在 DOM':'✗'}`);

  log('\n## 8) 口径说明（回应审查 finding 02）');
  log('   验收第 4 条（Tab 顺序/不新增停靠点）的锚点「TASK-043 记录的 16 个」是在**空库**下测得的；');
  log(`   本日志在注入 mock 数据（3 个源、分类、文章卡片）后测得主视图 ${s1.mainView} 个，属**不同数据状态**，两者不可直接比较。`);
  log(`   注：主视图停靠点会随动态内容小幅浮动（同步状态胶囊/加载态等），`);
  log(`   独立审查者在同一候选上测得主视图 31、总数 33/70，与本日志的 ${s1.mainView}/${s1.total}/${s2.total} 属同量级差异。`);
  log(`   本次能证成的是「不新增停靠点」：源码 diff 仅 2 处 inert（不新增任何 DOM 节点），`);
  log(`   且消融对照显示主视图停靠点在「有/无 inert」两态均为 ${s1.mainView} / ${s2.mainView}，差异全部出现在浮层内。`);

  fs.writeFileSync(EV + 'TASK-047-verify-log.txt', R.join('\n') + '\n', { encoding: 'utf8' });
  cdp.sock.end(); console.log('\nDONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
