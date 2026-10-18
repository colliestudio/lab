// @vitest-environment happy-dom
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { describe, expect, it } from 'vitest';
import { App } from './app';
import { Presence, mountPresenceView } from './presence';

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const app = new App(root);
  app.store.load({ nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' }], edges: [] });
  const mine = new Awareness(new Y.Doc());
  const theirs = new Awareness(new Y.Doc());
  theirs.on('update', ({ added, updated, removed }: any) => applyAwarenessUpdate(mine, encodeAwarenessUpdate(theirs, [...added, ...updated, ...removed]), 'net'));
  const presence = new Presence(mine, { id: 'viewer', name: 'Viewer', color: '#000' });
  const other = new Presence(theirs, { id: 'agent:claude', name: 'Claude', color: '#f00' });
  mountPresenceView(app, presence);
  return { app, root, other };
}

describe('presence view', () => {
  it('draws a peer’s cursor and selection outline', () => {
    const { root, other, app } = setup();
    other.setCursor({ x: 5, y: 5 });
    other.setSelection(['n1']);
    expect(root.querySelectorAll('.cv-cursor')).toHaveLength(1);
    expect(app.view.boxOf('n1')?.classList.contains('cv-remote-sel')).toBe(true);
  });

  it('hidePeer leaves a seat out: no cursor, no name tag, no outline', () => {
    const { root, other, app } = setup();
    app.hidePeer = (id) => id === 'agent:claude';
    other.setCursor({ x: 5, y: 5 });
    other.setSelection(['n1']);
    expect(root.querySelectorAll('.cv-cursor')).toHaveLength(0);
    expect(app.view.boxOf('n1')?.classList.contains('cv-remote-sel')).toBe(false);
  });
});
