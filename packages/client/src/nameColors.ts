/**
 * Name badge colors in the novel view. A character without `color:` gets one of these by
 * slug. Each has a variant per mode, with at least 4.5:1 against NAME_TEXT of that mode, which
 * the badge uses with them whatever the theme preset.
 */
export const NAME_TEXT = { light: '#ffffff', dark: '#1b1916' } as const;

export const NAME_PRESETS = [
  { light: '#8e3b46', dark: '#e79aa3' },
  { light: '#2f6b3a', dark: '#8fcf98' },
  { light: '#1f5c8a', dark: '#8cbde6' },
  { light: '#6b4391', dark: '#c4a3e0' },
  { light: '#7d5200', dark: '#e6b85c' },
  { light: '#2b6666', dark: '#7fcfcf' },
] as const;

/** The preset for a slug: the same character always gets the same one. */
export function namePreset(slug: string): (typeof NAME_PRESETS)[number] {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return NAME_PRESETS[hash % NAME_PRESETS.length] ?? NAME_PRESETS[0];
}

/** WCAG contrast ratio of two `#rrggbb` colors. */
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
