import './theme.css';
import type { App } from './app';
import type { MenuEntry } from './plugin';
import { PRESETS, THEME_PREFS, backgroundOf, loadThemePref, lookOf, normalizeColor, resolveTheme, saveThemePref, type ThemePref } from './theme';

const LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/**
 * Make the table look the way the board (its background) and this device (its theme) say.
 * `forceLight`: the screenshot page, which must not depend on the machine it runs on.
 */
export function mountTheme(app: App, opts: { forceLight?: boolean } = {}) {
  const root = app.view.root;
  const html = document.documentElement;
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
  let pref: ThemePref = opts.forceLight ? 'light' : loadThemePref();

  const apply = () => {
    const theme = resolveTheme(pref, !!media?.matches);
    html.dataset.theme = theme;
    html.style.colorScheme = theme;
    const look = lookOf(backgroundOf(app.store.doc.extra), theme);
    root.style.setProperty('--cv-bg', look.bg);
    root.style.setProperty('--cv-dot', look.dot);
    root.style.setProperty('--cv-ink', look.ink);
    root.dataset.board = look.dark ? 'dark' : 'light';
  };
  media?.addEventListener('change', apply);
  app.store.subscribe(apply);
  apply();

  const setBackground = (color: string | null) => app.dispatch('core.background', { color });

  // the native picker: a hidden input that opens on the menu row's click and commits when it closes
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.style.cssText = 'position:fixed;left:50%;top:50%;width:1px;height:1px;opacity:0;pointer-events:none;';
  picker.addEventListener('change', () => setBackground(picker.value));
  document.body.append(picker);

  app.registerMainMenuItem({
    id: 'view.background',
    group: 'View',
    order: 0,
    when: () => !app.readOnly,
    entry: (): MenuEntry => {
      const cur = backgroundOf(app.store.doc.extra);
      const custom = !!cur && !PRESETS.some((p) => p.color === cur);
      return {
        label: 'Background',
        items: [
          { label: 'Automatic', checked: !cur, run: () => setBackground(null) },
          ...PRESETS.map((p, i): MenuEntry => ({ label: p.name, color: p.color, checked: cur === p.color, separator: i === 0, run: () => setBackground(p.color) })),
          {
            label: 'Custom…',
            checked: custom,
            separator: true,
            run: () => {
              picker.value = normalizeColor(cur) ?? lookOf(undefined, resolveTheme(pref, !!media?.matches)).bg;
              if (picker.showPicker) picker.showPicker();
              else picker.click();
            },
          },
        ],
      };
    },
  });
  app.registerMainMenuItem({
    id: 'view.theme',
    group: 'View',
    order: 1,
    when: () => !opts.forceLight,
    entry: (): MenuEntry => ({
      label: 'Theme',
      items: THEME_PREFS.map((t): MenuEntry => ({
        label: LABEL[t],
        checked: pref === t,
        run: () => {
          pref = t;
          saveThemePref(t);
          apply();
        },
      })),
    }),
  });
  return { get pref() { return pref; }, apply };
}
