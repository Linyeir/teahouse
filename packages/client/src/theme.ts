import {
  DEFAULT_THEME_PRESET,
  isThemeId,
  isThemePreset,
  resolveThemeMode,
  type ThemeModePreference,
} from '@teahouse/shared';
import { useEffect, useSyncExternalStore } from 'react';
import {
  customThemeCss,
  getCustomThemes,
  storeFirstPaint,
  subscribeCustomThemes,
} from './customThemes.ts';

/*
 * Theme choice, per device. The inline script in index.html applies the stored choice before the
 * first paint with the same keys and rules; keep the two in step.
 */
const MODE_KEY = 'teahouse.theme';
const PRESET_KEY = 'teahouse.preset';
const WORLD_THEMES_KEY = 'teahouse.worldThemes';
/** The <style> that holds the shown uploaded theme; index.html creates it with the same ID. */
const STYLE_ID = 'custom-theme';

export interface ThemeSettings {
  mode: ThemeModePreference;
  /** A built-in preset or the ID of an uploaded theme. */
  preset: string;
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

/** Whether a preset can be shown here: built in, or uploaded and synced to this device. */
export function isKnownPreset(preset: unknown): preset is string {
  return isThemePreset(preset) || getCustomThemes().some((t) => t.id === preset);
}

function load(): ThemeSettings {
  const mode = read(MODE_KEY);
  const preset = read(PRESET_KEY);
  return {
    mode: mode === 'light' || mode === 'dark' ? mode : 'system',
    // An uploaded theme this device has not synced yet is kept: it shows once it arrives.
    preset: isThemePreset(preset) || isThemeId(preset) ? preset : DEFAULT_THEME_PRESET,
    worldThemes: read(WORLD_THEMES_KEY) !== 'off',
  };
}

let settings = load();
let worldPreset: string | null = null;
const listeners = new Set<() => void>();
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/** The preset and mode shown now: a world's preset wins while you are in that world. */
export function activeTheme(state = settings, world = worldPreset) {
  const wanted = (state.worldThemes && world && isKnownPreset(world) && world) || state.preset;
  const preset = isKnownPreset(wanted) ? wanted : DEFAULT_THEME_PRESET;
  return {
    preset,
    mode: resolveThemeMode(preset, state.mode, media?.matches ?? false, getCustomThemes()),
  };
}

let shownCss: string | null = null;

function apply() {
  const { preset, mode } = activeTheme();
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.preset = preset;
  void showCustomCss(isThemePreset(preset) ? null : preset);
}

/** Puts the uploaded theme's CSS in the page, or takes it out for a built-in preset. */
async function showCustomCss(id: string | null) {
  if (shownCss === id) return;
  shownCss = id;
  const css = id ? await customThemeCss(id) : '';
  // Another preset may have been chosen while IndexedDB answered.
  if (shownCss !== id) return;
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = css ?? '';
  // Only the chosen theme matters for the next start; a world's theme follows its page.
  if (id && id === settings.preset) {
    storeFirstPaint(getCustomThemes().find((t) => t.id === id) ?? null, css ?? '');
  } else if (isThemePreset(settings.preset)) storeFirstPaint(null);
}

function notify() {
  apply();
  for (const listener of listeners) listener();
}

media?.addEventListener('change', notify);
subscribeCustomThemes(() => {
  // A theme may have arrived, changed or gone: show it again from the fresh copy.
  shownCss = null;
  notify();
});

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
  const valid = isThemePreset(preset) || isThemeId(preset) ? preset : null;
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
