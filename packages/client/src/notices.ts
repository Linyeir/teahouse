import { useSyncExternalStore } from 'react';

/** Short messages that outlive the view that caused them, e.g. a conflict on reconnect. */
export interface Notice {
  id: number;
  text: string;
  kind: 'info' | 'warning' | 'error' | 'toast';
  /** For a toast: plain lines under the text, e.g. one per changed file. */
  lines?: string[];
  /** For a toast: one action, such as starting a chat. */
  action?: { label: string; onClick: () => void };
}

let notices: Notice[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function pushNotice(text: string, kind: Notice['kind'] = 'info'): void {
  notices = [...notices, { id: nextId++, text, kind }];
  emit();
}

/**
 * Confirms that something worked, at the bottom of the screen until dismissed. A new toast
 * replaces the one before.
 */
export function pushToast(text: string, extra: Pick<Notice, 'lines' | 'action'> = {}): void {
  notices = [
    ...notices.filter((n) => n.kind !== 'toast'),
    { id: nextId++, text, kind: 'toast', ...extra },
  ];
  emit();
}

export function dismissNotice(id: number): void {
  notices = notices.filter((n) => n.id !== id);
  emit();
}

export function useNotices(): Notice[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notices,
  );
}
