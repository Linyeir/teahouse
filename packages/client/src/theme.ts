import {
  DEFAULT_THEME_PRESET,
  isThemePreset,
  resolveThemeMode,
  type ThemeModePreference,
  type ThemePresetId,
} from '@teahouse/shared';
import { useEffect, useSyncExternalStore } from 'react';

/*
 * Theme choice, per device. The inline script in index.html applies the stored choice before the
 * first paint with the same keys and rules; keep the two in step.
 */
const MODE_KEY = 'teahouse.theme';
const PRESET_KEY = 'teahouse.preset';
const WORLD_THEMES_KEY = 'teahouse.worldThemes';

export interface ThemeSettings {
  mode: ThemeModePreference;
  preset: ThemePresetId;
  /** Worlds that name a preset switch the app to it while you are in them. */
  worldThemes: boolean;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this visit.
  }
}

function load(): ThemeSettings {
  const mode = read(MODE_KEY);
  const preset = read(PRESET_KEY);
  return {
    mode: mode === 'light' || mode === 'dark' ? mode : 'system',
    preset: isThemePreset(preset) ? preset : DEFAULT_THEME_PRESET,
    worldThemes: read(WORLD_THEMES_KEY) !== 'off',
  };
}

let settings = load();
let worldPreset: ThemePresetId | null = null;
const listeners = new Set<() => void>();
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/** The preset and mode shown now: a world's preset wins while you are in that world. */
export function activeTheme(state = settings, world = worldPreset) {
  const preset = (state.worldThemes && world) || state.preset;
  return { preset, mode: resolveThemeMode(preset, state.mode, media?.matches ?? false) };
}

function apply() {
  const { preset, mode } = activeTheme();
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.preset = preset;
}

function notify() {
  apply();
  for (const listener of listeners) listener();
}

media?.addEventListener('change', notify);

export function getThemeSettings(): ThemeSettings {
  return settings;
}

export function setThemeSettings(next: Partial<ThemeSettings>) {
  settings = { ...settings, ...next };
  write(MODE_KEY, settings.mode === 'system' ? null : settings.mode);
  write(PRESET_KEY, settings.preset === DEFAULT_THEME_PRESET ? null : settings.preset);
  write(WORLD_THEMES_KEY, settings.worldThemes ? null : 'off');
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemeSettings(): ThemeSettings {
  return useSyncExternalStore(subscribe, getThemeSettings);
}

/** Shows the world's preset while the calling view is mounted, unless world themes are off. */
export function useWorldTheme(preset: string | null | undefined) {
  const valid = isThemePreset(preset) ? preset : null;
  useEffect(() => {
    if (!valid) return;
    worldPreset = valid;
    notify();
    return () => {
      if (worldPreset === valid) worldPreset = null;
      notify();
    };
  }, [valid]);
}

/** Called once at startup, in case the inline script did not run. */
export function initTheme() {
  apply();
}
