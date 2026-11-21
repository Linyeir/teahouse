import { type CustomTheme, isThemeId } from '@teahouse/shared';
import { createStore, del, get, keys, set } from 'idb-keyval';
import { useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { withoutFiles } from './themeFiles.ts';

/*
 * Uploaded themes on this device. The list lives in localStorage, so the theme settings can
 * check a stored choice synchronously at startup; each theme's CSS (fonts and images inlined)
 * lives in IndexedDB, so every theme works offline once this device has synced it.
 */
const LIST_KEY = 'teahouse.customThemes';
/** The chosen theme's CSS, read by the inline script in index.html before the first paint. */
export const FIRST_PAINT_KEY = 'teahouse.themeCss';

const cssStore = createStore('teahouse-themes', 'css');

interface StoredCss {
  hash: string;
  css: string;
}

function readList(): CustomTheme[] {
  try {
    const list = JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]') as CustomTheme[];
    return Array.isArray(list) ? list.filter((t) => isThemeId(t?.id)) : [];
  } catch {
    return [];
  }
}

let themes = readList();
const listeners = new Set<() => void>();

function setList(next: CustomTheme[]) {
  themes = next;
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(next));
  } catch {
    // Without storage the list lasts for this visit.
  }
  for (const listener of listeners) listener();
}

export function getCustomThemes(): CustomTheme[] {
  return themes;
}

export function subscribeCustomThemes(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCustomThemes(): CustomTheme[] {
  return useSyncExternalStore(subscribeCustomThemes, getCustomThemes);
}

/** The CSS of an uploaded theme from this device's copy, or null if it has none yet. */
export async function customThemeCss(id: string): Promise<string | null> {
  const stored = await get<StoredCss>(id, cssStore).catch(() => undefined);
  return stored?.css ?? null;
}

let syncing: Promise<void> | null = null;

/**
 * Brings this device's copy in line with the server: fetches the CSS of new or changed themes,
 * forgets removed ones. Runs on connect and whenever a theme is uploaded or removed anywhere.
 */
export function syncCustomThemes(): Promise<void> {
  syncing ??= (async () => {
    try {
      const list = await api.get<CustomTheme[]>('/api/themes');
      for (const theme of list) {
        const stored = await get<StoredCss>(theme.id, cssStore).catch(() => undefined);
        if (stored?.hash === theme.hash) continue;
        const { css } = await api.get<{ css: string }>(`/api/themes/${theme.id}/css`);
        await set(theme.id, { hash: theme.hash, css } satisfies StoredCss, cssStore);
      }
      const ids = new Set(list.map((t) => t.id));
      for (const key of await keys(cssStore)) {
        if (!ids.has(String(key))) await del(key, cssStore);
      }
      setList(list);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/**
 * The CSS kept for the first paint. localStorage holds a few MB at most; a theme with large
 * fonts or images keeps its colors there and gets the files a moment later from IndexedDB.
 */
export function storeFirstPaint(theme: Pick<CustomTheme, 'id' | 'modes'> | null, css = '') {
  try {
    if (!theme) {
      localStorage.removeItem(FIRST_PAINT_KEY);
      return;
    }
    const entry = (text: string) => JSON.stringify({ id: theme.id, modes: theme.modes, css: text });
    try {
      localStorage.setItem(FIRST_PAINT_KEY, entry(css));
    } catch {
      localStorage.setItem(FIRST_PAINT_KEY, entry(withoutFiles(css)));
    }
  } catch {
    // No storage: the theme appears once IndexedDB has answered.
  }
}
