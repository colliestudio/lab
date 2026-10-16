import type { Probe } from './probe';

/**
 * Full-page screen for a served board that can't be opened (missing, made by a newer canvas, unreadable).
 * It covers the table, so it keeps files dropped on it and keys typed on it from reaching the table.
 */
export function showBoardScreen(probe: Exclude<Probe, { kind: 'ok' } | { kind: 'none' }>, name: string) {
  const overlay = document.createElement('div');
  overlay.className = 'serve-screen';
  const card = document.createElement('div');
  card.className = 'serve-card';
  card.setAttribute('role', 'alert');
  const title = document.createElement('h2');
  const body = document.createElement('p');
  body.textContent = probe.error;
  if (probe.kind === 'missing') {
    title.textContent = `No board named “${name}”`;
    body.textContent = 'It may have been renamed or deleted.';
  } else if (probe.kind === 'newer') {
    title.textContent = 'Made by a newer canvas';
    body.textContent = `${probe.error} Upgrade canvas serve to open it. The file is untouched.`;
  } else title.textContent = `Can’t open “${name}”`;
  const actions = document.createElement('div');
  actions.className = 'serve-actions';
  const all = document.createElement('a');
  all.href = '/';
  all.textContent = 'All boards';
  actions.append(all);
  if (probe.kind === 'failed') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => location.reload());
    actions.append(retry);
  }
  card.append(title, body, actions);
  overlay.append(card);

  for (const t of ['dragover', 'drop'] as const) {
    overlay.addEventListener(t, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }
  // keys go to the screen, not to the table under it
  window.addEventListener(
    'keydown',
    (e) => {
      if (!overlay.contains(e.target as Node)) e.stopImmediatePropagation();
    },
    true,
  );
  document.body.append(overlay);
  (actions.querySelector('a, button') as HTMLElement).focus();
}
