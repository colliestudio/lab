import { ICE, type App, type Room } from '../core';
import { VoiceChat } from './chat';

/** Toolbar controls (Join voice / mute / spatial / leave) and the speaking indicators on player chips and cursors. */
export function mountVoice(app: App, room: Room, bar: HTMLElement): VoiceChat {
  const aw = room.presence.awareness;
  const world = (c: { x: number; y: number } | null | undefined) => (c ? { x: c.x, y: c.y } : null);
  const chat = new VoiceChat(aw, {
    iceServers: ICE,
    position: () => {
      const mine = world((aw.getLocalState() as { cursor?: { x: number; y: number } | null } | null)?.cursor);
      if (mine) return mine;
      const vp = app.viewport;
      return { x: (innerWidth / 2 - vp.x) / vp.zoom, y: (innerHeight / 2 - vp.y) / vp.zoom };
    },
    positionOf: (id) => world((aw.getStates().get(id) as { cursor?: { x: number; y: number } | null } | undefined)?.cursor),
  });

  const box = document.createElement('span');
  box.className = 'voice';
  const join = document.createElement('button');
  join.textContent = 'Join voice';
  join.title = 'Talk with the players at this table (asks for your microphone)';
  const mute = document.createElement('button');
  const spatial = document.createElement('button');
  spatial.textContent = 'Near';
  spatial.title = 'Hear players louder when their cursor is close to yours';
  const leave = document.createElement('button');
  leave.textContent = 'Leave voice';
  const note = document.createElement('span');
  note.className = 'voice-note';
  box.append(join, mute, spatial, leave, note);
  bar.append(box);

  join.addEventListener('click', async () => {
    join.disabled = true;
    await chat.join();
    join.disabled = false;
  });
  mute.addEventListener('click', () => chat.setMuted(!chat.muted));
  spatial.addEventListener('click', () => chat.setSpatial(!chat.spatial));
  leave.addEventListener('click', () => chat.leave());

  const refresh = () => {
    const on = chat.joined;
    join.hidden = on;
    mute.hidden = spatial.hidden = leave.hidden = !on;
    mute.textContent = chat.muted ? 'Unmute' : 'Mute';
    mute.title = chat.muted ? 'Others can’t hear you: click to talk' : 'Stop sending your microphone';
    mute.classList.toggle('active', chat.muted);
    spatial.classList.toggle('active', chat.spatial);
    note.textContent = chat.error;
    box.classList.toggle('error', !!chat.error);
    const members = new Map(chat.members().map((m) => [m.id, m]));
    const speaking = chat.speaking();
    const me = aw.clientID;
    for (const chip of bar.querySelectorAll<HTMLElement>('.player[data-client]')) {
      const id = Number(chip.dataset.client);
      const m = members.get(id);
      const inVoice = id === me ? on : !!m;
      const muted = id === me ? chat.muted : !!m?.muted;
      chip.classList.toggle('in-voice', inVoice);
      chip.classList.toggle('muted', inVoice && muted);
      chip.classList.toggle('speaking', speaking.has(id));
      chip.dataset.link = id === me || !m ? '' : m.connected ? 'up' : 'connecting';
      let mic = chip.querySelector<HTMLElement>('.mic');
      if (inVoice && !mic) {
        mic = document.createElement('u');
        mic.className = 'mic';
        chip.append(mic);
      }
      if (mic) {
        if (!inVoice) mic.remove();
        else mic.textContent = muted ? '🔇' : '🎙';
      }
    }
    for (const cur of document.querySelectorAll<HTMLElement>('.cv-cursor[data-client]')) {
      const id = Number(cur.dataset.client);
      cur.classList.toggle('speaking', speaking.has(id));
      cur.classList.toggle('voice-muted', !!members.get(id)?.muted);
    }
  };
  chat.onChange(refresh);
  room.presence.onChange(refresh);
  setInterval(refresh, 500);
  refresh();
  window.addEventListener('beforeunload', () => chat.leave());
  (window as any).__voiceStats = () => chat.stats();
  return chat;
}
