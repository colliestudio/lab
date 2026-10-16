import WebSocket from 'ws'; import * as Y from 'yjs'; import { WebsocketProvider } from 'y-websocket';
const p = new WebsocketProvider('ws://127.0.0.1:5248/ws/real', 'canvas', new Y.Doc(), { WebSocketPolyfill: WebSocket });
setTimeout(async () => {
  const H={'content-type':'application/json'};
  for (const [u,b] of [['rename',{to:'r2'}],['delete',{}]]) { const r = await fetch('http://127.0.0.1:5248/api/boards/real/'+u,{method:'POST',headers:H,body:JSON.stringify(b)}); console.log(u, r.status, await r.text()); }
  console.log(await (await fetch('http://127.0.0.1:5248/api/boards')).text().then(t=>JSON.parse(t).find(x=>x.name==='real')));
  p.destroy(); process.exit(0);
}, 2000);
