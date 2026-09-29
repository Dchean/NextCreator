import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
const httpGet=(p)=>new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9222,path:p},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}).on('error',rej);});
const list=JSON.parse(await httpGet('/json/list'));
const page=list.find(t=>t.type==='page');
console.log('target:', page.url);
const url=new URL(page.webSocketDebuggerUrl);
console.log('ws:', url.href.slice(0,80));
const sock=net.connect(Number(url.port), url.hostname, ()=>{
  const key=crypto.randomBytes(16).toString('base64');
  sock.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
});
let hs=false, buf=Buffer.alloc(0);
const pending=new Map(); let id=0;
function frame(ch){
  buf=Buffer.concat([buf,ch]);
  for(;;){
    const b=buf; if(b.length<2)return;
    const op=b[0]&0x0f; let len=b[1]&0x7f, off=2;
    if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4;}
    else if(len===127){if(b.length<10)return;len=Number(b.readBigUInt64BE(2));off=10;}
    if(b.length<off+len)return;
    const pl=b.subarray(off,off+len); buf=b.subarray(off+len);
    if(op===1){const m=JSON.parse(pl.toString('utf8')); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}}
  }
}
sock.on('data',(ch)=>{
  if(!hs){ const s=ch.toString('latin1'); const i=s.indexOf('\r\n\r\n'); if(i===-1)return; hs=true;
    console.log('handshake:', s.split('\r\n')[0]);
    const rest=ch.subarray(i+4); if(rest.length)frame(rest); return; }
  frame(ch);
});
function send(method,params={}){
  const i=++id; const pl=Buffer.from(JSON.stringify({id:i,method,params}),'utf8');
  const mask=crypto.randomBytes(4); let h; const L=pl.length;
  if(L<126){h=Buffer.alloc(6);h[1]=0x80|L;}else if(L<65536){h=Buffer.alloc(8);h[1]=0x80|126;h.writeUInt16BE(L,2);}else{h=Buffer.alloc(14);h[1]=0x80|127;h.writeBigUInt64BE(BigInt(L),2);}
  h[0]=0x81;mask.copy(h,h.length-4);const m=Buffer.alloc(L);for(let k=0;k<L;k++)m[k]=pl[k]^mask[k%4];
  sock.write(Buffer.concat([h,m]));
  return new Promise(r=>pending.set(i,r));
}
await new Promise(r=>setTimeout(r,600));
console.log('sending Runtime.evaluate...');
const res=await Promise.race([send('Runtime.evaluate',{expression:'document.title',returnByValue:true}), new Promise(r=>setTimeout(()=>r({timeout:true}),8000))]);
console.log('result:', JSON.stringify(res).slice(0,200));
sock.end();
console.log('OK');
