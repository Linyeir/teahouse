import type { ApiError } from '@teahouse/shared';

const TOKEN_KEY = 'teahouse.token';

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
  const response = await fetch(path, {
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
    if (response.status === 401 && token) setToken(null);
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
  return `/api/worlds/${worldId}/assets/${rel}?token=${encodeURIComponent(getToken() ?? '')}`;
}

/** Downloads an authenticated file (e.g. a world export) through the browser. */
export async function download(path: string): Promise<void> {
  const token = getToken();
  const response = await fetch(path, {
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
