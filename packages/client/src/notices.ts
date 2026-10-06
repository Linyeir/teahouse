import { useSyncExternalStore } from 'react';

/** Short messages that outlive the view that caused them, e.g. a conflict on reconnect. */
export interface Notice {
  id: number;
  text: string;
  kind: 'info' | 'warning' | 'error';
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
