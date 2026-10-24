import { useSyncExternalStore } from 'react';

/**
 * Unsaved edits of world files, per world and path, for as long as the page lives. Switching
 * files keeps them, and a refetch of the file (a canon update, an edit in another editor)
 * never overwrites them: the edit stays against the content it started from.
 */
export interface FileDraft {
  text: string;
  /** Content the edit started from, and its `sha`, to save against. */
  base: string;
  baseSha: string | undefined;
}

const drafts = new Map<string, FileDraft>();
const listeners = new Set<() => void>();
/** Snapshots per world for `useSyncExternalStore`, which needs a stable value per state. */
const dirtyPaths = new Map<string, string[]>();

const key = (worldId: string, path: string) => `${worldId}\n${path}`;

function changed(worldId: string): void {
  const prefix = `${worldId}\n`;
  dirtyPaths.set(
    worldId,
    [...drafts.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
  );
  for (const listener of listeners) listener();
}

export function getDraft(worldId: string, path: string): FileDraft | undefined {
  return drafts.get(key(worldId, path));
}

/** Records an edit. Typed back to its base, the file is clean again. */
export function setDraft(worldId: string, path: string, draft: FileDraft): void {
  if (draft.text === draft.base) drafts.delete(key(worldId, path));
  else drafts.set(key(worldId, path), draft);
  changed(worldId);
}

export function clearDraft(worldId: string, path: string): void {
  if (drafts.delete(key(worldId, path))) changed(worldId);
}

export function clearDrafts(worldId: string): void {
  for (const path of dirtyPaths.get(worldId) ?? []) drafts.delete(key(worldId, path));
  changed(worldId);
}

const EMPTY: string[] = [];

/** Paths of the world with unsaved edits. */
export function useDirtyPaths(worldId: string): string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => dirtyPaths.get(worldId) ?? EMPTY,
    () => dirtyPaths.get(worldId) ?? EMPTY,
  );
}

/** The draft of one file, re-rendering when it changes. */
export function useDraft(worldId: string, path: string): FileDraft | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getDraft(worldId, path),
    () => getDraft(worldId, path),
  );
}
