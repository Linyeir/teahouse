import {
  type Compatibility,
  compatibility,
  type ServerVersion,
  TEAHOUSE_VERSION,
} from '@teahouse/shared';
import { useSyncExternalStore } from 'react';
import { api, isApp, RequestError } from './api.ts';
import i18n from './i18n.ts';

export interface VersionCheck {
  compatibility: Compatibility;
  /** The server's Teahouse version, or null for servers before 0.3.2, which do not report it. */
  server: string | null;
}

// The last result, readable outside the view that asked (see Layout).
let last: VersionCheck | null = null;
const listeners = new Set<() => void>();

/**
 * Asks the server for its version and API version. Servers before 0.3.2 have no endpoint
 * for it: they answer 404, or 401 without a token, and count as API version 1.
 */
export async function checkServerVersion(): Promise<VersionCheck> {
  let result: VersionCheck;
  try {
    const { version, api: serverApi } = await api.get<ServerVersion>('/api/version');
    result = { compatibility: compatibility(serverApi), server: version };
  } catch (err) {
    if (!(err instanceof RequestError && (err.status === 404 || err.status === 401))) throw err;
    result = { compatibility: compatibility(1), server: null };
  }
  last = result;
  for (const listener of listeners) listener();
  return result;
}

/** The result of the last check, or null before the first one. */
export function useServerVersion(): VersionCheck | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => last,
  );
}

/** What to tell the user about a check, or null when app and server fit together. */
export function versionMessage(check: VersionCheck | null): string | null {
  if (!check || check.compatibility === 'ok') return null;
  const versions = {
    app: TEAHOUSE_VERSION,
    server: check.server ?? i18n.t('version.before032'),
  };
  if (check.compatibility === 'update-server') return i18n.t('version.updateServer', versions);
  // In a browser the server delivers the client, so only a stale cached copy can be too old.
  return i18n.t(isApp ? 'version.updateApp' : 'version.reload', versions);
}

/** Throws when this app and the current server do not work together. */
export async function assertCompatibleServer(): Promise<void> {
  const message = versionMessage(await checkServerVersion());
  if (message) throw new Error(message);
}
