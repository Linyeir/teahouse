/** A theme mode. `system` follows the device setting. */
export type ThemeMode = 'light' | 'dark';
export type ThemeModePreference = ThemeMode | 'system';

/**
 * Built-in theme presets (docs/theming.md). A preset with one mode always uses it; the others
 * follow the light/dark setting. The CSS for each lives in the client's themes.css.
 */
export const THEME_PRESETS = [
  { id: 'standard', modes: ['light', 'dark'] },
  { id: 'nord', modes: ['light', 'dark'] },
  { id: 'catppuccin', modes: ['light', 'dark'] },
  { id: 'sakura', modes: ['light'] },
  { id: 'halftone', modes: ['light'] },
  { id: 'picturebook', modes: ['light'] },
  { id: 'dracula', modes: ['dark'] },
  { id: 'cyberpunk', modes: ['dark'] },
  { id: 'gothic', modes: ['dark'] },
] as const satisfies readonly { id: string; modes: readonly ThemeMode[] }[];

export type ThemePresetId = (typeof THEME_PRESETS)[number]['id'];
export const DEFAULT_THEME_PRESET: ThemePresetId = 'standard';

export function isThemePreset(value: unknown): value is ThemePresetId {
  return typeof value === 'string' && THEME_PRESETS.some((p) => p.id === value);
}

/** The mode a preset is shown in, given the user's preference and the device setting. */
export function resolveThemeMode(
  preset: ThemePresetId,
  preference: ThemeModePreference,
  systemDark: boolean,
): ThemeMode {
  const modes: readonly ThemeMode[] =
    THEME_PRESETS.find((p) => p.id === preset)?.modes ?? THEME_PRESETS[0].modes;
  const wanted: ThemeMode = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  return modes.includes(wanted) ? wanted : (modes[0] ?? 'light');
}
