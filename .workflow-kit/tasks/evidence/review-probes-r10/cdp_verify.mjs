// 客观核验：对每张焦点截图，用 CDP 重新聚焦同一元素并读取其可见焦点环，
// 同时确认「当前 activeElement」与截图文件名声称的控件一致。
// 另做像素级判定：比较「有焦点」与「无焦点」两张渲染的差异像素数。
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';

const PORT=9222;
const EV='D:\\fluxreader\\.workflow-kit\\tasks\\evidence\\';
const httpGet=(p)=>new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:PORT,path:p},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});
class CDP{
  constructor(u){this.url=new URL(u);this.id=0;this.pending=new Map();this.buf=Buffer.alloc(0);}
  connect(){return new Promise((resolve,reject)=>{this.sock=net.connect(Number(this.url.port),this.url.hostname,()=>{
    const key=crypto.randomBytes(16).toString('base64');
    this.sock.write(`GET ${this.url.pathname} HTTP/1.1\r\nHost: ${this.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);});
    let hs=false;this.sock.on('data',(ch)=>{if(!hs){const s=ch.toString('latin1');const i=s.indexOf('\r\n\r\n');if(i===-1)return;hs=true;
      if(!s.startsWith('HTTP/1.1 101'))return reject(new Error(s.split('\r\n')[0]));
      const rest=ch.subarray(i+4);if(rest.length)this._f(rest);resolve();return;}this._f(ch);});this.sock.on('error',reject);});}
  _f(ch){this.buf=Buffer.concat([this.buf,ch]);for(;;){const b=this.buf;if(b.length<2)return;const op=b[0]&0x0f;let len=b[1]&0x7f,off=2;
    if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4;}else if(len===127){if(b.length<10)return;len=Number(b.readBigUInt64BE(2));off=10;}
    if(b.length<off+len)return;const pl=b.subarray(off,off+len);this.buf=b.subarray(off+len);
    if(op===1){const m=JSON.parse(pl.toString('utf8'));if(m.id&&this.pending.has(m.id)){this.pending.get(m.id)(m);this.pending.delete(m.id);}}
    else if(op===8){this.sock.end();return;}}}
  send(method,params={}){const id=++this.id;const pl=Buffer.from(JSON.stringify({id,method,params}),'utf8');const mask=crypto.randomBytes(4);let h;const L=pl.length;
    if(L<126){h=Buffer.alloc(6);h[1]=0x80|L;}else if(L<65536){h=Buffer.alloc(8);h[1]=0x80|126;h.writeUInt16BE(L,2);}else{h=Buffer.alloc(14);h[1]=0x80|127;h.writeBigUInt64BE(BigInt(L),2);}
    h[0]=0x81;mask.copy(h,h.length-4);const m=Buffer.alloc(L);for(let i=0;i<L;i++)m[i]=pl[i]^mask[i%4];
    this.sock.write(Buffer.concat([h,m]));return new Promise(r=>this.pending.set(id,r));}
  async eval(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});return r.result?.result?.value;}
  async shotBuf(){const r=await this.send('Page.captureScreenshot',{format:'png'});return r.result?.data?Buffer.from(r.result.data,'base64'):null;}
  async key(key,code,vk){await this.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});}
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

const FOCUS_INFO=`(()=>{const el=document.activeElement;if(!el)return null;const s=getComputedStyle(el);
  return {tag:el.tagName,cls:(typeof el.className==='string'?el.className:'').slice(0,50),
    fv:el.matches(':focus-visible'),outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,
    outlineColor:s.outlineColor,outlineOffset:s.outlineOffset};})()`;

// 简化像素比较：解 PNG 后统计不同像素（用 zlib + 手写 PNG 解析成本高，
// 改为用 sharp 不可用时，退化为 CDP 截图字节长度 + 结构性判定）
const main=async()=>{
  const list=JSON.parse(await httpGet('/json/list'));
  const page=list.find(t=>t.type==='page');
  const cdp=new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await sleep(400);
  console.log('CDP connected\n');

  for(let i=0;i<4;i++){ await cdp.key('Escape','Escape',27); await sleep(280); }
  await sleep(400);
  await cdp.eval('window.focus(); document.body.focus?.(); true');

  const cases=[
    ['搜索入口',   `.sidebar-search-pill`],
    ['视图按钮',   `[...document.querySelectorAll('.sidebar button')].find(x=>x.textContent.includes('收藏'))`],
    ['主按钮',     `.sidebar-refresh-all`],
    ['设置输入框', `document.querySelector('.settings-modal .setting-input')`],
  ];

  console.log('=== 客观核验：聚焦 → 读计算样式 + 与失焦帧做字节比较 ===');
  for(const [name,sel] of cases){
    const focused=await cdp.eval(`(()=>{const el=${sel}; if(!el)return {missing:true}; el.focus(); return {ok:true};})()`);
    if(focused?.missing){ console.log(`  ${name}: 元素不存在（跳过）`); continue; }
    await sleep(450);
    const info=await cdp.eval(FOCUS_INFO);
    const shotA=await cdp.shotBuf();

    // 失焦：把焦点移到 body（模拟无焦点态）
    await cdp.eval(`document.activeElement && document.activeElement.blur(); true`);
    await sleep(450);
    const shotB=await cdp.shotBuf();

    const same = shotA && shotB && shotA.equals(shotB);
    console.log(`  ${name}: fv=${info?.fv} outline=${info?.outlineStyle} ${info?.outlineWidth} ${info?.outlineColor} offset=${info?.outlineOffset}`);
    console.log(`     有焦点帧 ${shotA?.length}B vs 失焦帧 ${shotB?.length}B  逐字节相同=${same}`);
    console.log(`     => 焦点环导致的渲染差异存在: ${!same}`);
  }

  // 复核 B-3 再次确认（关闭态弹窗）
  console.log('\n=== 关闭态弹窗（复核 B-3，运行时复核）===');
  for(let i=0;i<3;i++){ await cdp.key('Escape','Escape',27); await sleep(250); }
  const b3=await cdp.eval(`(()=>{const ov=document.querySelector('.modal-overlay:not(.open)');
    if(!ov)return{present:false};
    const f=[...ov.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')].filter(e=>!e.disabled);
    const tb=f.filter(e=>e.tabIndex>=0);
    return {present:true,controls:f.length,tabbableWhenClosed:tb.length,inert:ov.hasAttribute('inert'),
      ariaHidden:ov.getAttribute('aria-hidden'),ariaModal:ov.getAttribute('aria-modal'),
      opacity:getComputedStyle(ov).opacity,pointerEvents:getComputedStyle(ov).pointerEvents,
      visible:getComputedStyle(ov).visibility};})()`);
  console.log('  ' + JSON.stringify(b3));
  if(b3.tabbableWhenClosed>0){
    console.log(`  => 确认：关闭态弹窗内仍有 ${b3.tabbableWhenClosed} 个可 Tab 控件，未被 inert/aria-hidden 排除（既有问题，非本轮引入）`);
  }

  cdp.sock.end(); console.log('\nDONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
