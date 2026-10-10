import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { roomDbName, type App, type Room } from './core';

// Rooms in the app shell: create/share a room, show who's here and the connection state.

export const roomFromUrl = () => new URLSearchParams(location.search).get('room');

export function roomLink(id: string) {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('room', id);
  const signal = new URLSearchParams(location.search).get('signal');
  if (signal) u.searchParams.set('signal', signal);
  return u.toString();
}

/** Copy text; works on plain http too (navigator.clipboard needs a secure context). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

const newRoomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

/** New room seeded with a copy of the current table (stored locally under the room's name). */
export async function createRoomFrom(app: App): Promise<string> {
  const id = newRoomId();
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(app.store.ydoc));
  const p = new IndexeddbPersistence(roomDbName(id), copy);
  await p.whenSynced;
  await p.destroy();
  copy.destroy();
  return id;
}

/** Toolbar: players (color dot + name) and status (room, peers, signaling). */
export function mountRoomStatus(app: App, room: Room, bar: HTMLElement, onLeave: () => void, onRename: () => void) {
  const box = document.createElement('span');
  box.className = 'room';
  const players = document.createElement('span');
  players.className = 'players';
  const state = document.createElement('span');
  state.className = 'room-state';
  const copy = document.createElement('button');
  copy.textContent = 'Copy link';
  copy.title = 'Copy the invite link to this table';
  copy.addEventListener('click', async () => {
    const link = roomLink(room.id);
    app.notify((await copyText(link)) ? 'Link copied' : `Share this link: ${link}`);
  });
  const leave = document.createElement('button');
  leave.textContent = 'Leave';
  leave.title = 'Back to your own table (this room stays on this device)';
  leave.addEventListener('click', onLeave);
  box.append(players, state, copy, leave);
  bar.append(box);

  const dot = (color: string, name: string, you = false) => {
    const s = document.createElement(you ? 'button' : 'span');
    s.className = you ? 'player me' : 'player';
    s.title = you ? 'You: click to change your name or color' : name;
    if (you) s.addEventListener('click', onRename);
    s.innerHTML = `<i></i><b></b>`;
    (s.firstChild as HTMLElement).style.background = color;
    (s.lastChild as HTMLElement).textContent = you ? `${name} (you)` : name;
    return s;
  };
  const started = Date.now();
  let everConnected = false;
  const draw = () => {
    const me = room.presence.me;
    // rebuild only when it changed, so a click on your own entry isn't lost to a re-render
    const peers = room.presence.peers();
    const key = JSON.stringify([me.name, me.color, peers.map((p) => [p.clientId, p.name, p.color])]);
    if (key !== players.dataset.key) {
      players.dataset.key = key;
      players.replaceChildren(dot(me.color, me.name, true), ...peers.map((p) => dot(p.color, p.name)));
    }
    const sig = room.signalingConnected();
    everConnected ||= sig;
    const connecting = !sig && !everConnected && Date.now() - started < 8000;
    const n = room.connectedPeers();
    state.dataset.ok = String(sig || connecting);
    state.textContent = `room ${room.id} · ${n} peer${n === 1 ? '' : 's'} · ${sig ? 'online' : connecting ? 'connecting…' : 'signaling offline'}`;
    state.title = sig ? 'Connected to the signaling server' : 'Can’t reach the signaling server: changes stay local and sync when it’s back';
  };
  room.presence.onChange(draw);
  room.provider.on('peers', draw);
  setInterval(draw, 1000);
  draw();
}
