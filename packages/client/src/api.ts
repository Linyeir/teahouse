import type { ApiError } from '@teahouse/shared';

const TOKEN_KEY = 'teahouse.token';
const SERVER_KEY = 'teahouse.server';

/** Whether the client runs inside a Tauri app rather than a browser tab of the server. */
export const isApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Base URL of the server, without a trailing slash. Empty means the origin the client was
 * loaded from, which is the normal case in a browser. The apps always need one.
 */
export function getServer(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setServer(server: string): void {
  const normalized = normalizeServer(server);
  try {
    if (normalized) localStorage.setItem(SERVER_KEY, normalized);
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    // Storage unavailable: the address lasts until reload.
  }
}

/** `host:port` or a full URL to a base URL; the page's own origin becomes empty. */
export function normalizeServer(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return !isApp && url.origin === window.location.origin && url.pathname === '/' ? '' : base;
}

/** Absolute URL of a server path. */
export const serverUrl = (path: string) => `${getServer()}${path}`;

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): the session lasts until reload.
  }
  window.dispatchEvent(new Event('teahouse:auth'));
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const isForm = body instanceof FormData;
  const response = await fetch(serverUrl(path), {
    method,
    headers: {
      ...(body !== undefined && !isForm && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const err = (data ?? {}) as Partial<ApiError>;
    // Only a rejected token signs out; a wrong password or pairing code is a 401 too.
    if (response.status === 401 && err.error === 'unauthorized' && token) setToken(null);
    throw new RequestError(
      response.status,
      err.error ?? 'unknown',
      err.message ?? response.statusText,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
};

/** URL of a world asset for <img>, which cannot send the Authorization header. */
export function assetUrl(worldId: string, file: string): string {
  const rel = file
    .replace(/^assets\//, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `${getServer()}/api/worlds/${worldId}/assets/${rel}?token=${encodeURIComponent(getToken() ?? '')}`;
}

/** Downloads an authenticated file (e.g. a world export) through the browser. */
export async function download(path: string): Promise<void> {
  const token = getToken();
  const response = await fetch(serverUrl(path), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as Partial<ApiError>;
    throw new RequestError(
      response.status,
      err.error ?? 'unknown',
      err.message ?? response.statusText,
    );
  }
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
