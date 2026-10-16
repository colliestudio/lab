/** JSON Canvas preset colors "1".."6" (red, orange, yellow, green, cyan, purple), or any CSS color as is. */
export const PRESET_COLORS: Record<string, string> = { '1': '#fb464c', '2': '#e9973f', '3': '#e0de71', '4': '#44cf6e', '5': '#53dfdd', '6': '#a882ff' };

export const canvasColor = (c: string | undefined): string | undefined => (c ? (PRESET_COLORS[c] ?? c) : undefined);
