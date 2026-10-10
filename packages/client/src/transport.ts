import { invoke } from '@tauri-apps/api/core';
import type { Certificate } from './diagnose.ts';
import { isApp } from './platform.ts';

/**
 * Requests to the server through the app instead of the webview (issue #27), for servers the
 * webview cannot verify on its own: a self-signed certificate the user accepted, or a private
 * CA the platform trusts while the webview ignores it (LineageOS's webview, for one). The app
 * decides trust in packages/app/src-tauri/src/transport. Browsers always use their own fetch.
 */

const NATIVE_KEY = 'teahouse.native';

/** `https://host:port` with the port always given, as the app keys its pins. */
export function originOf(server: string): string | null {
  try {
    const url = new URL(server);
    if (url.protocol !== 'https:') return null;
    return `https://${url.hostname}:${url.port || '443'}`;
  } catch {
    return null;
  }
}

function nativeOrigins(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(NATIVE_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((o): o is string => typeof o === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether requests to `server` (or any URL on it) go through the app. */
export function usesNativeTransport(server: string): boolean {
  const origin = isApp ? originOf(server) : null;
  return origin !== null && nativeOrigins().includes(origin);
}

export function setNativeTransport(server: string, on: boolean): void {
  const origin = originOf(server);
  if (!origin) return;
  const others = nativeOrigins().filter((o) => o !== origin);
  try {
    localStorage.setItem(NATIVE_KEY, JSON.stringify(on ? [...others, origin] : others));
  } catch {
    // Storage unavailable: the setting lasts until reload.
  }
}

/** Neither the platform nor an accepted certificate trusts the server. */
export class UntrustedCertificateError extends Error {
  constructor(
    readonly certificate: Certificate,
    /** A certificate was accepted for this server, and it now presents another one. */
    readonly pinned: boolean,
  ) {
    super(pinned ? 'The server presents a different certificate' : 'Untrusted certificate');
  }
}

interface NativeResponse {
  status: number;
  headers: [string, string][];
  /** Base64. */
  body: string;
}

type NativeError =
  | { kind: 'untrusted'; certificate: Certificate; pinned: boolean }
  | { kind: 'network' | 'invalidRequest'; message: string };

/** The server's fetch: through the app for servers that need it, else the webview's. */
export function serverFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return usesNativeTransport(url) ? nativeFetch(url, init) : fetch(url, init);
}

async function nativeFetch(url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  let body: string | undefined;
  if (init.body !== undefined && init.body !== null) {
    // Encodes the body as the webview would, FormData as multipart with its boundary.
    const encoded = new Response(init.body);
    const type = encoded.headers.get('content-type');
    if (type && !headers.has('content-type')) headers.set('content-type', type);
    body = toBase64(new Uint8Array(await encoded.arrayBuffer()));
  }
  let response: NativeResponse;
  try {
    response = await invoke<NativeResponse>('native_fetch', {
      request: { url, method: init.method ?? 'GET', headers: [...headers.entries()], body },
    });
  } catch (err) {
    throw toError(err);
  }
  // These statuses must not have a body, or the Response constructor throws.
  const empty = [101, 204, 205, 304].includes(response.status);
  return new Response(empty ? null : fromBase64(response.body), {
    status: response.status,
    headers: response.headers,
  });
}

/** The error a webview fetch would throw, or an UntrustedCertificateError. */
function toError(err: unknown): Error {
  const native = err as NativeError | null;
  if (native?.kind === 'untrusted') {
    return new UntrustedCertificateError(native.certificate, native.pinned);
  }
  const message = native && 'message' in native ? native.message : String(err);
  return new TypeError(`Failed to fetch: ${message}`);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In chunks: spreading a large array into fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
