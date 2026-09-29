// TASK-043 第二轮 CDP 验证：主视图 Tab 顺序、下拉键盘操作、右键菜单、关闭态弹窗
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';

const PORT = 9222;
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
    if(r.result?.exceptionDetails) return {__err:r.result.exceptionDetails.text}; return r.result?.result?.value; }
  async key(key,code,vk,extra={}){ 
    await this.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,...extra});
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
  }
  async click(x,y,button='left'){ 
    await this.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button,clickCount:1,buttons:button==='right'?2:1});
    await this.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button,clickCount:1,buttons:button==='right'?2:1});
  }
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const DESC=`(()=>{const el=document.activeElement; if(!el)return{none:true};
  const cls=(typeof el.className==='string'?el.className:(el.getAttribute('class')||''));
  const s=getComputedStyle(el);
  return {tag:el.tagName,cls:cls.slice(0,44),role:el.getAttribute('role'),type:el.getAttribute('type'),
    ti:el.tabIndex,label:(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,26),
    fv:el.matches(':focus-visible'),outline:s.outlineStyle+'/'+s.outlineWidth};})()`;

const main=async()=>{
  const list=JSON.parse(await httpGet('/json/list'));
  const page=list.find(t=>t.type==='page');
  const cdp=new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await sleep(400);
  console.log('CDP connected\n');

  // --- 关闭所有浮层，回主视图 ---
  for (let i=0;i<4;i++){ await cdp.key('Escape','Escape',27); await sleep(350); }
  await sleep(600);
  const view=async()=>await cdp.eval(`(()=>({
    settings: !!document.querySelector('.settings-modal'),
    palette: !!document.querySelector('.cp-list'),
    lightbox: !!document.querySelector('.lightbox-open')||!!document.querySelector('.lightbox-img'),
    ctxMenu: !!document.querySelector('.ctx-menu'),
  }))()`);
  console.log('=== 关闭浮层后状态 ===');
  console.log(JSON.stringify(await view()));

  // --- 主视图 Tab 顺序 ---
  await cdp.eval('window.focus(); document.body.focus?.(); true');
  await sleep(250);
  console.log('\n=== 主视图 Tab 顺序（activeElement 序列）===');
  const seq=[];
  for(let i=1;i<=16;i++){
    await cdp.key('Tab','Tab',9); await sleep(180);
    const d=await cdp.eval(DESC); seq.push(d);
    console.log(`  tab${String(i).padStart(2)} ${d.tag}${d.role?`[${d.role}]`:''}${d.type?`[${d.type}]`:''} ti=${d.ti} fv=${d.fv} ol=${d.outline} :: ${(d.label||d.cls||'').slice(0,30)}`);
  }
  const uniq=new Set(seq.map(s=>s.tag+'|'+s.cls+'|'+s.label));
  console.log(`\n  去重停靠点 ${uniq.size}/${seq.length}；全部 :focus-visible = ${seq.every(s=>s.fv===true)}`);
  console.log(`  命中 ti=-1 的次数（应 0）= ${seq.filter(s=>s.ti===-1).length}`);

  // --- FluxDropdown 键盘操作（功能性验证）---
  console.log('\n=== FluxDropdown 键盘操作 ===');
  const ddOpen=await cdp.eval(`(()=>{const t=document.querySelector('.flux-dropdown-trigger'); if(!t)return{present:false};
    t.focus(); return {present:true, focused:document.activeElement===t, role:t.getAttribute('role'), ti:t.tabIndex, expandedBefore:t.getAttribute('aria-expanded')};})()`);
  console.log('  focus 到触发器:', JSON.stringify(ddOpen));
  await cdp.key('ArrowDown','ArrowDown',40); await sleep(450);
  const afterOpen=await cdp.eval(`(()=>{const m=document.querySelector('.flux-dropdown-menu');
    return {menuOpen:!!m, expanded:document.querySelector('.flux-dropdown-trigger')?.getAttribute('aria-expanded'),
            options:document.querySelectorAll('.flux-dropdown-option').length,
            kbActive:document.querySelectorAll('.flux-dropdown-option.kb-active').length,
            role:m?m.getAttribute('role'):null};})()`);
  console.log('  ArrowDown 后:', JSON.stringify(afterOpen));
  const before=await cdp.eval(`document.querySelector('.flux-dropdown-label')?.textContent`);
  await cdp.key('ArrowDown','ArrowDown',40); await sleep(300);
  const midKb=await cdp.eval(`document.querySelectorAll('.flux-dropdown-option.kb-active').length`);
  await cdp.key('Enter','Enter',13); await sleep(400);
  const after=await cdp.eval(`(()=>{const m=document.querySelector('.flux-dropdown-menu');
    return {menuClosed:!m, label:document.querySelector('.flux-dropdown-label')?.textContent};})()`);
  console.log(`  选中前 label="${before}"  高亮项数=${midKb}  Enter 后: ${JSON.stringify(after)}`);
  console.log(`  键盘改变取值: ${before!==after.label}`);

  // --- 右键菜单键盘可达性 ---
  console.log('\n=== 右键菜单 ===');
  const rb=await cdp.eval(`(()=>{const c=document.querySelector('[data-ctx]');
    if(!c)return{found:false}; const r=c.getBoundingClientRect(); return {found:true,x:Math.round(r.left+r.width/2),y:Math.round(r.top+18)};})()`);
  console.log('  目标元素:', JSON.stringify(rb));
  if(rb.found){
    await cdp.click(rb.x,rb.y,'right'); await sleep(700);
    const cm=await cdp.eval(`(()=>{const m=document.querySelector('.ctx-menu'); if(!m)return{open:false};
      const items=[...m.querySelectorAll('.ctx-menu-item')];
      return {open:true, role:m.getAttribute('role'), items:items.length,
        itemRoles:[...new Set(items.map(i=>i.getAttribute('role')))],
        tabbable:items.filter(i=>i.tabIndex>=0).length,
        disabledTab:-1===items.filter(i=>i.classList.contains('disabled')).map(i=>i.tabIndex).find(v=>v!==-1)||null};})()`);
    console.log('  菜单:', JSON.stringify(cm));
    // 键盘在菜单里操作
    await cdp.eval(`document.querySelector('.ctx-menu-item[tabindex="0"]')?.focus(); true`);
    const f1=await cdp.eval(DESC);
    console.log('  聚焦菜单项:', JSON.stringify(f1));
    await cdp.key('Escape','Escape',27); await sleep(300);
  }

  // --- 关闭态弹窗是否在 Tab 序列（复核 B-3）---
  console.log('\n=== 关闭态弹窗可达性（复核 B-3）===');
  const closed=await cdp.eval(`(()=>{const ov=document.querySelector('.modal-overlay:not(.open)');
    if(!ov)return{present:false};
    const f=[...ov.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')].filter(e=>!e.disabled);
    return {present:true, controls:f.length, tabbable:f.filter(e=>e.tabIndex>=0).length,
      inert:ov.hasAttribute('inert'), ariaHidden:ov.getAttribute('aria-hidden'),
      display:getComputedStyle(ov).display, opacity:getComputedStyle(ov).opacity};})()`);
  console.log('  ' + JSON.stringify(closed));

  // --- 焦点环宽度实测（确认非 0）---
  const ring=await cdp.eval(`(()=>{const btn=document.querySelector('.settings-modal button')||document.querySelector('button');
    btn.focus(); const s=getComputedStyle(btn); return {outlineStyle:s.outlineStyle, outlineWidth:s.outlineWidth, outlineColor:s.outlineColor, fv:btn.matches(':focus-visible'), dpr:window.devicePixelRatio};})()`);
  console.log('\n=== 焦点环计算样式 ===');
  console.log('  ' + JSON.stringify(ring));

  cdp.sock.end(); console.log('\nDONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
