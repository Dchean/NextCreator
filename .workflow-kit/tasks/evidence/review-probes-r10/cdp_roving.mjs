// 通过 CDP + Vite dev 模块图，把 mock 条目注入内存态，用来实机验证列表卡片的 roving tabindex。
// 只改内存 store，不写任何数据库/文件。
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
  async eval(e){ const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true,userGesture:true});
    if(r.result?.exceptionDetails) return {__err: (r.result.exceptionDetails.text||'')+' '+(r.result.exceptionDetails.exception?.description||'')};
    return r.result?.result?.value; }
  async key(key,code,vk,modifiers=0){ await this.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers});
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers}); }
  async shot(p){ const r=await this.send('Page.captureScreenshot',{format:'png'}); if(!r.result?.data)return false;
    fs.writeFileSync(p,Buffer.from(r.result.data,'base64')); return true; }
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const HASH=(p)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0,16);

const main=async()=>{
  const list=JSON.parse(await httpGet('/json/list'));
  const page=list.find(t=>t.type==='page');
  const cdp=new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await sleep(500);
  console.log('CDP connected\n');

  // 1) 经 Vite 模块图取 store 与 mock 数据（dev 环境直接 import TS 源码）
  const inject = await cdp.eval(`(async () => {
    try {
      const storeMod = await import('/src/store.ts');
      const mockMod  = await import('/src/mockData.ts');
      const s = storeMod.useAppStore;
      const cats = mockMod.createInitialCategories();
      const entries = mockMod.createInitialEntries();
      // 只改内存态：mock 数据 + 关闭浮层 + 确保 article 布局
      s.setState({
        dataMode: 'mock',
        dataLoading: false,
        categories: cats,
        feedIndex: storeMod.buildFeedIndex ? storeMod.buildFeedIndex(cats) : s.getState().feedIndex,
        entries,
        activeContentLayout: 'article',
        activeViewFilter: 'all',
        activeFeedFilter: 'all',
        timelineFilter: 'all',
        articlesLoading: false,
        articlesExhausted: true,
        settingsOpen: false,
        searchOpen: false,
        activeArticleId: null,
      });
      return { ok: true, cats: cats.length, entries: entries.length };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  })()`);
  console.log('注入内存 mock 数据:', JSON.stringify(inject));
  await sleep(1500);

  const cards = await cdp.eval(`(() => {
    const c=[...document.querySelectorAll('[data-card-index]')];
    return { total:c.length, tabbable:c.filter(x=>x.tabIndex===0).length,
             roles:[...new Set(c.map(x=>x.getAttribute('role')))],
             idxs:c.map(x=>x.getAttribute('data-card-index')).slice(0,6) };
  })()`);
  console.log('列表卡片:', JSON.stringify(cards));

  if (cards.total > 0) {
    // 2) 焦点进入列表：Alt+Tab 不行，用键盘 Tab 走到卡片（或直接点第一张卡后按 Tab 回退不可靠）
    //    改为：模拟点击第一张卡片（CDP 鼠标事件，仅作用于该渲染器），再用方向键移动
    const box = await cdp.eval(`(() => {
      const c=document.querySelector('[data-card-index]');
      if(!c) return null; const r=c.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+20)};
    })()`);
    console.log('第一张卡片坐标:', JSON.stringify(box));
    if (box) {
      await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',clickCount:1,buttons:1});
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x,y:box.y,button:'left',clickCount:1,buttons:1});
      await sleep(800);
    }

    // 3) Tab 遍历：记录卡片是否进入序列、以及 roving 是否只放一个
    console.log('\n=== Tab 遍历（含卡片）===');
    const seq=[];
    for(let i=1;i<=26;i++){
      await cdp.key('Tab','Tab',9); await sleep(130);
      const d=await cdp.eval(`(()=>{const el=document.activeElement;if(!el)return null;
        return {tag:el.tagName,cls:(typeof el.className==='string'?el.className:'').slice(0,40),
          ti:el.tabIndex,ci:el.getAttribute('data-card-index'),role:el.getAttribute('role'),
          fv:el.matches(':focus-visible')};})()`);
      if(!d) continue;
      seq.push(d);
      if(d.ci!==null) console.log(`  tab${i} 卡片数据点 -> data-card-index=${d.ci} ti=${d.ti} fv=${d.fv} role=${d.role}`);
    }
    const cardStops = seq.filter(s=>s.ci!==null);
    console.log(`\n  卡片停靠点 ${cardStops.length} 个；其余 ${seq.length-cardStops.length} 个`);
    console.log(`  卡片 ti=0 的个数（roving 应每组恰好 1）= ${cardStops.filter(s=>s.ti===0).length}`);

    const after = await cdp.eval(`(()=>{const c=[...document.querySelectorAll('[data-card-index]')];
      return {total:c.length, tabbable:c.filter(x=>x.tabIndex===0).length};})()`);
    console.log('  遍历后卡片状态:', JSON.stringify(after));

    // 4) 方向键在卡片间移动（roving 的组内导航）
    const before = await cdp.eval(`document.activeElement?.getAttribute('data-card-index')`);
    await cdp.key('ArrowDown','ArrowDown',40); await sleep(600);
    const afterKey = await cdp.eval(`document.activeElement?.getAttribute('data-card-index')`);
    console.log(`\n  方向键移动焦点: ${before} -> ${afterKey}  改变=${before!==afterKey}`);

    const p1 = EV+'TASK-043-12-list-cards-mock.png';
    if (await cdp.shot(p1)) console.log(`  saved ${p1.split('\\\\').pop()} sha=${HASH(p1)}`);

    // 5) 画廊布局（GalleryCard 全量渲染）下的 roving
    await cdp.eval(`useAppStore === undefined; true`);
    await cdp.eval(`(async()=>{const m=await import('/src/store.ts'); m.useAppStore.setState({activeContentLayout:'image'}); return true;})()`);
    await sleep(1200);
    const gal = await cdp.eval(`(()=>{const c=[...document.querySelectorAll('[data-card-index]')];
      return {total:c.length, tabbable:c.filter(x=>x.tabIndex===0).length};})()`);
    console.log('\n  画廊布局卡片:', JSON.stringify(gal));
    const p2 = EV+'TASK-043-13-gallery-roving.png';
    if (await cdp.shot(p2)) console.log(`  saved ${p2.split('\\\\').pop()} sha=${HASH(p2)}`);
  } else {
    console.log('未渲染出卡片，跳过 roving 实机验证');
  }

  console.log('\nDONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
