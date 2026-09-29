// roving tabindex 实机验证（仅改内存 store，不写数据库）
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
  async eval(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});
    if(r.result?.exceptionDetails)return{__err:(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text||'').slice(0,300)};
    return r.result?.result?.value;}
  async key(key,code,vk){await this.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});}
  async shot(p){const r=await this.send('Page.captureScreenshot',{format:'png'});if(!r.result?.data)return false;
    fs.writeFileSync(p,Buffer.from(r.result.data,'base64'));return true;}
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const HASH=(p)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0,16);

const main=async()=>{
  const list=JSON.parse(await httpGet('/json/list'));
  const page=list.find(t=>t.type==='page');
  const cdp=new CDP(page.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await sleep(500);
  console.log('CDP connected');

  const inj=await cdp.eval(`(async()=>{
    try{
      const storeMod=await import('/src/store.ts');
      const mockMod=await import('/src/mockData.ts');
      const s=storeMod.useAppStore;
      const cats=mockMod.createInitialCategories();
      const entries=mockMod.createInitialEntries();
      // 复刻 buildFeedIndex（未导出）：feedId -> {feed, cat}
      const feedIndex=new Map();
      for(const cat of cats) for(const f of cat.feeds) feedIndex.set(f.id,{feed:f,cat});
      s.setState({dataMode:'mock',dataLoading:false,categories:cats,feedIndex,entries,
        activeContentLayout:'article',activeViewFilter:'all',activeFeedFilter:'all',timelineFilter:'all',
        articlesLoading:false,articlesExhausted:true,settingsOpen:false,searchOpen:false,activeArticleId:null});
      return {ok:true,fx:feedIndex.size,entries:entries.length};
    }catch(e){return{ok:false,err:String(e&&e.message||e)};}
  })()`);
  console.log('注入:',JSON.stringify(inj));
  await sleep(1800);

  const cards=await cdp.eval(`(()=>{const c=[...document.querySelectorAll('[data-card-index]')];
    return {total:c.length,tabbable:c.filter(x=>x.tabIndex===0).length,roles:[...new Set(c.map(x=>x.getAttribute('role')))]};})()`);
  console.log('卡片:',JSON.stringify(cards));

  if(cards.total>0){
    // 聚焦第一张卡片（脚本聚焦即可，用于验证 roving 与方向键；fv 单独用 Tab 验证）
    await cdp.eval(`document.querySelector('[data-card-index]')?.focus(); true`);
    await sleep(400);
    const b=await cdp.eval(`document.activeElement?.getAttribute('data-card-index')`);
    console.log(`\n初始焦点卡片: ${b}`);
    console.log('=== 方向键在卡片间移动（roving 组内导航）===');
    for(const [k,code,vk] of [['ArrowDown','ArrowDown',40],['ArrowDown','ArrowDown',40],['ArrowUp','ArrowUp',38]]){
      await cdp.key(k,code,vk); await sleep(500);
      const cur=await cdp.eval(`document.activeElement?.getAttribute('data-card-index')`);
      console.log(`  ${k} -> data-card-index=${cur}`);
    }
    // roving 不变式：任意时刻恰有一个 tabIndex=0
    const inv=await cdp.eval(`(()=>{const c=[...document.querySelectorAll('[data-card-index]')];
      return {total:c.length,tabbable:c.filter(x=>x.tabIndex===0).length};})()`);
    console.log(`\nroving 不变式: 卡片 ${inv.total} 张，tabIndex=0 的有 ${inv.tabbable} 张（应恰为 1）`);
    const p1=EV+'TASK-043-12-list-roving.png';
    if(await cdp.shot(p1)) console.log(`saved 12 sha=${HASH(p1)}`);

    // 键盘 Enter 激活（等价性）
    const before=await cdp.eval(`(async()=>{const m=await import('/src/store.ts'); return m.useAppStore.getState().activeArticleId;})()`);
    await cdp.key('Enter','Enter',13); await sleep(800);
    const after=await cdp.eval(`(async()=>{const m=await import('/src/store.ts'); return m.useAppStore.getState().activeArticleId;})()`);
    console.log(`\nEnter 激活卡片: activeArticleId ${before} -> ${after}  改变=${before!==after}`);

    // 画廊布局 roving
    await cdp.eval(`(async()=>{const m=await import('/src/store.ts'); m.useAppStore.setState({activeContentLayout:'image'}); return true;})()`);
    await sleep(1500);
    const gal=await cdp.eval(`(()=>{const c=[...document.querySelectorAll('[data-card-index]')];
      return {total:c.length,tabbable:c.filter(x=>x.tabIndex===0).length,roles:[...new Set(c.map(x=>x.getAttribute('role')))]};})()`);
    console.log(`画廊布局: ${JSON.stringify(gal)}  （tabIndex=0 应恰为 1）`);
    const p2=EV+'TASK-043-13-gallery-roving.png';
    if(await cdp.shot(p2)) console.log(`saved 13 sha=${HASH(p2)}`);
  } else { console.log('仍无卡片'); }
  console.log('\nDONE');
};
main().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
