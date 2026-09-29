// 用 CDP Page.captureScreenshot 抓真实渲染帧（含焦点环），写入 evidence。
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';

const PORT = 9222;
const EV = 'D:\\fluxreader\\.workflow-kit\\tasks\\evidence\\';
const httpGet = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error', rej);
});

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
    for(;;){ const b=this.buf; if(b.length<2)return;
      const op=b[0]&0x0f; let len=b[1]&0x7f, off=2;
      if(len===126){ if(b.length<4)return; len=b.readUInt16BE(2); off=4; }
      else if(len===127){ if(b.length<10)return; len=Number(b.readBigUInt64BE(2)); off=10; }
      if(b.length<off+len)return;
      const pl=b.subarray(off,off+len); this.buf=b.subarray(off+len);
      if(op===1){ const m=JSON.parse(pl.toString('utf8')); if(m.id&&this.pending.has(m.id)){ this.pending.get(m.id)(m); this.pending.delete(m.id); } }
      else if(op===8){ this.sock.end(); return; }
    } }
  send(method,params={}){ const id=++this.id; const pl=Buffer.from(JSON.stringify({id,method,params}),'utf8');
    const mask=crypto.randomBytes(4); let h; const L=pl.length;
    if(L<126){h=Buffer.alloc(6);h[1]=0x80|L;} else if(L<65536){h=Buffer.alloc(8);h[1]=0x80|126;h.writeUInt16BE(L,2);} else {h=Buffer.alloc(14);h[1]=0x80|127;h.writeBigUInt64BE(BigInt(L),2);}
    h[0]=0x81; mask.copy(h,h.length-4); const m=Buffer.alloc(L); for(let i=0;i<L;i++)m[i]=pl[i]^mask[i%4];
    this.sock.write(Buffer.concat([h,m])); return new Promise(r=>this.pending.set(id,r)); }
  async eval(e){ const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});
    return r.result?.result?.value; }
  async key(key,code,vk){ await this.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk}); }
  async shot(path){
    const r=await this.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    if(!r.result?.data){ console.log('  shot failed', JSON.stringify(r).slice(0,120)); return false; }
    fs.writeFileSync(path, Buffer.from(r.result.data,'base64'));
    return true;
  }
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const HASH=(p)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0,16);

const main=async()=>{
  const list=JSON.parse(await httpGet('/json/list'));
  const page=list.find(t=>t.type==='page');
  const cdp=new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await sleep(400);
  console.log('CDP connected\n');

  const out=[];
  const save=async(name,label)=>{ const p=EV+name; const ok=await cdp.shot(p);
    if(ok){ out.push({name,label,sha:HASH(p),bytes:fs.statSync(p).size}); console.log(`  ${name}  ${fs.statSync(p).size} bytes  sha=${HASH(p)}  (${label})`);} };

  // 关掉所有浮层
  for(let i=0;i<4;i++){ await cdp.key('Escape','Escape',27); await sleep(300); }
  await sleep(500);
  await cdp.eval('window.focus(); document.body.focus?.(); true');

  console.log('=== 主视图：逐控件聚焦并截图 ===');
  // 1) 搜索入口（[role=button]，本轮焦点规则覆盖点）
  await cdp.eval(`document.querySelector('.sidebar-search-pill')?.focus(); true`);
  await sleep(400); await save('TASK-043-05-focus-search-entry.png','侧栏搜索入口 role=button 焦点环');

  // 2) 视图项按钮
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.nav-tab-item, .sidebar button')].find(x=>x.textContent.includes('收藏')); b?.focus(); return !!b;})()`);
  await sleep(400); await save('TASK-043-06-focus-view-button.png','侧栏视图按钮焦点环');

  // 3) 侧栏底部主按钮（本轮改用 .btn-primary）
  await cdp.eval(`document.querySelector('.sidebar-refresh-all')?.focus(); true`);
  await sleep(400);
  const mainBtn=await cdp.eval(`(()=>{const b=document.querySelector('.sidebar-refresh-all'); if(!b)return null;
    const s=getComputedStyle(b); return {cls:b.className, bg:s.backgroundColor, disabled:s.opacity, outline:s.outlineStyle+' '+s.outlineWidth+' '+s.outlineColor, fv:b.matches(':focus-visible')};})()`);
  console.log('    主按钮计算样式:', JSON.stringify(mainBtn));
  await save('TASK-043-07-focus-primary-button.png','侧栏主按钮 .btn-primary 焦点环');

  console.log('\n=== 下拉：键盘打开状态截图 ===');
  await cdp.eval(`document.querySelector('.flux-dropdown-trigger')?.focus(); true`);
  await sleep(300);
  const lbl0=await cdp.eval(`document.querySelector('.flux-dropdown-label')?.textContent`);
  await cdp.key('ArrowDown','ArrowDown',40); await sleep(500);
  const st=await cdp.eval(`(()=>{const m=document.querySelector('.flux-dropdown-menu');
    return {open:!!m, role:m?.getAttribute('role'), opts:document.querySelectorAll('.flux-dropdown-option').length,
      kbActive:document.querySelectorAll('.flux-dropdown-option.kb-active').length};})()`);
  console.log('    打开后:', JSON.stringify(st));
  await save('TASK-043-08-dropdown-keyboard-open.png','FluxDropdown 键盘打开 + 键盘高亮');
  await cdp.key('Enter','Enter',13); await sleep(400);
  const lbl1=await cdp.eval(`document.querySelector('.flux-dropdown-label')?.textContent`);
  console.log(`    Enter 提交: "${lbl0}" -> "${lbl1}"  改变=${lbl0!==lbl1}`);
  await save('TASK-043-09-dropdown-after-enter.png','FluxDropdown Enter 提交后');

  console.log('\n=== 设置页：Tab 到多个控件 ===');
  // Ctrl+, 打开设置
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,modifiers:2});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:',',code:'Comma',windowsVirtualKeyCode:188,modifiers:2});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:',',code:'Comma',windowsVirtualKeyCode:188,modifiers:2});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17});
  await sleep(1500);
  const sOpen=await cdp.eval(`!!document.querySelector('.settings-modal')`);
  console.log('    设置已打开:', sOpen);
  if(sOpen){
    for(let i=1;i<=3;i++){ await cdp.key('Tab','Tab',9); await sleep(350); }
    const d=await cdp.eval(`(()=>{const el=document.activeElement; const s=getComputedStyle(el);
      return {tag:el.tagName, cls:(typeof el.className==='string'?el.className:'').slice(0,40), fv:el.matches(':focus-visible'), outline:s.outlineStyle+' '+s.outlineWidth};})()`);
    console.log('    Tab 后:', JSON.stringify(d));
    await save('TASK-043-10-settings-focus-ring.png','设置页控件焦点环（Tab 到达）');
    // 关设置
    await cdp.key('Escape','Escape',27); await sleep(500);
  }

  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(out,null,1));
  cdp.sock.end();
  console.log('\nDONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
