import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

/**
 * Whether the server can be reached. TanStack Query pauses queries and mutations while this
 * is false and resumes them when it turns true, which is the whole offline queue
 * (concept, section 9). `navigator.onLine` alone is not enough: the network may be up while
 * the server is not (home server out of reach, laptop away from the LAN).
 */
let reachable = true;
let notify: ((online: boolean) => void) | null = null;

onlineManager.setEventListener((setOnline) => {
  notify = setOnline;
  setOnline(reachable);
  const offline = () => setReachable(false);
  window.addEventListener('offline', offline);
  return () => {
    notify = null;
    window.removeEventListener('offline', offline);
  };
});

export function setReachable(next: boolean): void {
  if (next === reachable) return;
  reachable = next;
  notify?.(next);
}

/** The request never reached the server. `cause` is what the webview reported. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Server unreachable', { cause });
    console.warn('Server unreachable:', cause);
  }
}

/** Mutations that are safe to replay, so they wait out an outage instead of failing. */
export const retryWhileOffline = (failures: number, error: unknown) =>
  error instanceof NetworkError && failures < 100;

export function useOnline(): boolean {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
  );
}
