// Look of the board and the app. Two separate settings:
//  - the board's background: a color kept in the board file (top-level `x-canvas-background`, a
//    "#rrggbb"), shared by everyone and drawn in agent screenshots;
//  - the app theme (light / dark / system): per device, for the chrome. A board without a
//    background of its own takes the theme's default; a board's own background always wins.

export const BACKGROUND_KEY = 'x-canvas-background';

export interface Preset {
  id: string;
  name: string;
  color: string;
}

export const PRESETS: readonly Preset[] = [
  { id: 'paper', name: 'Paper', color: '#f8f9fa' },
  { id: 'white', name: 'White', color: '#ffffff' },
  { id: 'warm', name: 'Warm', color: '#f5eee1' },
  { id: 'cool', name: 'Cool grey', color: '#e6e9ee' },
  { id: 'mint', name: 'Mint', color: '#e2f1e8' },
  { id: 'slate', name: 'Slate', color: '#2b3340' },
  { id: 'night', name: 'Near-black', color: '#101215' },
];

/** What a board without a background of its own looks like, per theme. */
export const DEFAULT_BACKGROUND = { light: '#f8f9fa', dark: '#17191d' } as const;

const HEX = /^#([0-9a-f]{6})$/i;

/** "#rgb" / "#rrggbb" to lower-case "#rrggbb"; undefined for anything else. */
export function normalizeColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX.test(s) ? s : undefined;
}

/** A preset's id or name ("slate", "Cool grey"), or a hex color, as a "#rrggbb". */
export function colorFromInput(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const key = v.trim().toLowerCase();
  return PRESETS.find((p) => p.id === key || p.name.toLowerCase() === key)?.color ?? normalizeColor(key);
}

/** The board's own background from a doc's top-level fields, if it set a valid one. */
export const backgroundOf = (extra: Record<string, unknown> | undefined): string | undefined => normalizeColor(extra?.[BACKGROUND_KEY]);

/** Perceived brightness 0..1 of a "#rrggbb". */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Does text on this color have to be light? */
export const isDarkColor = (hex: string) => luminance(hex) < 0.18;

export type ThemePref = 'light' | 'dark' | 'system';
export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];
export const THEME_KEY = 'canvas-poc:theme';

export const parseThemePref = (v: unknown): ThemePref => (v === 'light' || v === 'dark' ? v : 'system');

/** The theme in force: a chosen one, or the system's. */
export const resolveTheme = (pref: ThemePref, systemDark: boolean): 'light' | 'dark' => (pref === 'system' ? (systemDark ? 'dark' : 'light') : pref);

export interface Look {
  bg: string;
  /** Grid dots, quiet on this background. */
  dot: string;
  /** Color for what is drawn straight on the board (free text, arrows, their labels). */
  ink: string;
  dark: boolean;
}

/** Everything the board needs to look right for a background (undefined = the theme's default). */
export function lookOf(background: string | undefined, theme: 'light' | 'dark'): Look {
  const bg = background ?? DEFAULT_BACKGROUND[theme];
  const dark = isDarkColor(bg);
  return {
    bg,
    dot: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.14)',
    ink: dark ? '#eceff4' : '#1e1e1e',
    dark,
  };
}

// ---- per device

export function loadThemePref(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): ThemePref {
  try {
    return parseThemePref(storage?.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

export function saveThemePref(pref: ThemePref, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = safeStorage()) {
  try {
    if (pref === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, pref);
  } catch {
    /* private mode: the choice lasts until reload */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
