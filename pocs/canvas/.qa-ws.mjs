import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
const name = process.argv[2];
const doc = new Y.Doc();
const p = new WebsocketProvider('ws://127.0.0.1:5248/ws/' + encodeURIComponent(name), 'canvas', doc, { WebSocketPolyfill: WebSocket, maxBackoffTime: 100000 });
let synced = false;
p.on('sync', s => { synced = s; });
setTimeout(() => {
  console.log(name, 'synced=', synced, 'status=', p.wsconnected, 'keys=', [...doc.share.keys()].join(','));
  const m = doc.getMap?.('nodes'); 
  p.destroy(); process.exit(0);
}, 2500);
