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
  preset: string,
  preference: ThemeModePreference,
  systemDark: boolean,
  custom: readonly Pick<CustomTheme, 'id' | 'modes'>[] = [],
): ThemeMode {
  const modes: readonly ThemeMode[] =
    THEME_PRESETS.find((p) => p.id === preset)?.modes ??
    custom.find((t) => t.id === preset)?.modes ??
    THEME_PRESETS[0].modes;
  const wanted: ThemeMode = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  return modes.includes(wanted) ? wanted : (modes[0] ?? 'light');
}

/**
 * IDs of uploaded themes (docs/theming.md, "Build your own theme"): lowercase letters, digits
 * and dashes. A world names one with `themePreset:` like a built-in preset.
 */
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isThemeId(value: unknown): value is string {
  return typeof value === 'string' && THEME_ID.test(value);
}

/** An uploaded theme as the server lists it. Its CSS is fetched separately. */
export interface CustomTheme {
  id: string;
  name: string;
  author: string | null;
  modes: ThemeMode[];
  /** Changes when the theme's CSS changes, so devices know to fetch it again. */
  hash: string;
}

/**
 * Something the server left out of an uploaded theme, or changed. The theme is installed
 * anyway; the app says what happened in plain words.
 */
export type ThemeNoteCode =
  /** A property that is not a custom property (`--name`): only variables are allowed. */
  | 'not-variable'
  /** A value that could load something from outside the package. */
  | 'blocked-value'
  /** `url()` pointing at a file that is not in the package. */
  | 'missing-file'
  /** A rule other than `:root { … }` blocks, e.g. a selector or an at-rule. */
  | 'unsupported-rule'
  /** theme.json is not valid JSON or has fields of the wrong kind. */
  | 'bad-manifest'
  /** A font named in theme.json that the package does not contain. */
  | 'missing-font'
  /** The ID was taken, so the theme got a new one. */
  | 'renamed';

export interface ThemeNote {
  code: ThemeNoteCode;
  /** The property, file, rule or new ID the note is about. */
  detail: string;
}

export interface InstalledTheme {
  theme: CustomTheme;
  notes: ThemeNote[];
}
