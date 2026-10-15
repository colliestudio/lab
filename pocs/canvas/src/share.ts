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

/**
 * Top-right: players (color dot + name) and status (room, peers, signaling), plus a Share pill that
 * copies the invite link (not on a bridge). The room's actions (rename, copy link, leave) go in the
 * main menu's Room submenu.
 */
export function mountRoomStatus(app: App, room: Room, bar: HTMLElement, onLeave: () => void, onRename: () => void) {
  const box = document.createElement('span');
  box.className = 'room';
  const players = document.createElement('span');
  players.className = 'players';
  const state = document.createElement('span');
  state.className = 'room-state';
  const stateDot = document.createElement('i');
  stateDot.className = 'room-dot';
  const stateText = document.createElement('span');
  stateText.className = 'room-text';
  state.append(stateDot, stateText);
  box.append(players, state);
  bar.append(box);

  const isBridge = room.kind === 'bridge';
  const copyLink = async () => {
    const link = roomLink(room.id);
    app.notify((await copyText(link)) ? 'Link copied' : `Share this link: ${link}`);
  };
  if (!isBridge) {
    const share = document.createElement('button');
    share.type = 'button';
    share.textContent = 'Share';
    share.className = 'share-btn';
    share.dataset.tip = 'Copy the invite link';
    share.addEventListener('click', copyLink);
    bar.append(share);
  }
  app.registerMainMenuItem({ id: 'room.rename', group: 'Room', order: 0, entry: () => ({ label: 'Your name and color…', run: onRename }) });
  if (!isBridge) app.registerMainMenuItem({ id: 'room.copyLink', group: 'Room', order: 1, entry: () => ({ label: 'Copy invite link', run: copyLink }) });
  app.registerMainMenuItem({
    id: 'room.leave',
    group: 'Room',
    order: 2,
    entry: () => ({ label: isBridge ? 'Leave bridge' : 'Leave room', run: onLeave }),
  });

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
    const b = room.bridge?.() ?? 'none';
    state.dataset.ok = String(sig || connecting);
    const offline = isBridge ? (everConnected ? 'bridge offline, retrying' : 'can’t reach the bridge') : 'signaling offline';
    stateText.textContent = `${room.label ?? `room ${room.id}`} · ${isBridge ? `${room.presence.peers().length + 1} here` : `${n} peer${n === 1 ? '' : 's'}`} · ${sig ? 'online' : connecting ? 'connecting…' : offline}${b === 'none' ? '' : b === 'online' ? ' · bridge' : ' · bridge…'}`;
    state.title = isBridge
      ? sig
        ? 'Connected to the bridge'
        : 'Can’t reach the bridge: check the address and token (Bridge…). Changes made here stay local until it is back'
      : sig
        ? b === 'online' ? 'Connected to the signaling server, and to the bridge in this room' : 'Connected to the signaling server'
        : 'Can’t reach the signaling server: changes stay local and sync when it’s back';
  };
  room.presence.onChange(draw);
  setInterval(draw, 1000);
  draw();
}
