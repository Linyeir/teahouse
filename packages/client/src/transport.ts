import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { Certificate } from './diagnose.ts';
import { isApp } from './platform.ts';

/**
 * Requests to the server through the app instead of the webview (issue #27), for servers the
 * webview cannot verify on its own: a self-signed certificate the user accepted, or a private
 * CA the platform trusts while the webview ignores it (LineageOS's webview, for one). The app
 * decides trust in packages/app/src-tauri/src/transport. Browsers always use their own fetch.
 */

const NATIVE_KEY = 'teahouse.native';

/**
 * `https://host:port` with the port always given, as the app keys its pins. A `wss://` URL
 * belongs to the same server as `https://`.
 */
export function originOf(server: string): string | null {
  try {
    const url = new URL(server);
    if (url.protocol !== 'https:' && url.protocol !== 'wss:') return null;
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

/** A certificate the user accepted, by origin (packages/app/src-tauri/src/transport/pins.rs). */
export interface AcceptedCertificate {
  origin: string;
  sha256: string;
}

export function acceptedCertificates(): Promise<AcceptedCertificate[]> {
  return invoke<AcceptedCertificate[]>('list_pins');
}

/** Whether the platform alone (Android, the OS) trusts the server's certificate. */
export async function platformTrusts(server: string): Promise<boolean> {
  try {
    const trust = await invoke<{ result: string }>('platform_trust', { server });
    return trust.result === 'trusted';
  } catch {
    // An app without the native transport (Android before it is set up there).
    return false;
  }
}

/** Retries right away instead of waiting for the next probe (events.ts listens for this). */
function reconnect(): void {
  window.dispatchEvent(new Event('online'));
}

/** Connects to `server` through the app from now on: its certificate is fine, the webview is not. */
export function connectThroughApp(server: string): void {
  setNativeTransport(server, true);
  reconnect();
}

/** Trusts exactly the certificate with this fingerprint for `server` and connects through the app. */
export async function acceptCertificate(server: string, sha256: string): Promise<void> {
  await invoke('pin_certificate', { server, sha256 });
  setNativeTransport(server, true);
  reconnect();
}

/** Forgets the accepted certificate of `server`. The next attempt asks again. */
export function forgetCertificate(server: string): Promise<void> {
  return invoke('remove_pin', { server });
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

/** The app's URI scheme for images (packages/app/src-tauri/src/transport/assets.rs). */
const ASSET_SCHEME = 'teahouse-asset';

/**
 * The `src` for an image of the server: an image of a server on the native transport loads
 * through the app's scheme, which fetches and caches it there.
 */
export function assetSrc(url: string): string {
  return usesNativeTransport(url) ? convertFileSrc(url, ASSET_SCHEME) : url;
}

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

type SocketEvent =
  | { type: 'message'; data: string }
  | { type: 'close'; code: number; reason: string };

/**
 * A WebSocket through the app, with the parts of the WebSocket interface the client uses.
 * Messages that arrive before the open is confirmed are held back, as a browser would.
 */
export class NativeSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  #id: number | null = null;
  #closeWith: { code?: number; reason?: string } | null = null;
  #early: string[] = [];

  constructor(url: string) {
    const channel = new Channel<SocketEvent>();
    channel.onmessage = (event) => {
      if (event.type === 'close') {
        this.#closed(event.code, event.reason);
      } else if (this.readyState === WebSocket.CONNECTING) {
        this.#early.push(event.data);
      } else if (this.readyState === WebSocket.OPEN) {
        this.onmessage?.(new MessageEvent('message', { data: event.data }));
      }
    };
    invoke<number>('native_socket_open', { url, onEvent: channel }).then(
      (id) => {
        this.#id = id;
        if (this.#closeWith) {
          this.#sendClose();
          return;
        }
        if (this.readyState !== WebSocket.CONNECTING) return;
        this.readyState = WebSocket.OPEN;
        this.onopen?.(new Event('open'));
        for (const data of this.#early.splice(0)) {
          this.onmessage?.(new MessageEvent('message', { data }));
        }
      },
      (err: unknown) => {
        console.warn('WebSocket through the app failed:', toError(err));
        this.#closed(1006, '');
      },
    );
  }

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN || this.#id === null) {
      throw new DOMException('The socket is not open', 'InvalidStateError');
    }
    void invoke('native_socket_send', { id: this.#id, data }).catch(() => this.#closed(1006, ''));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    this.#closeWith = { code, reason };
    if (this.#id !== null) this.#sendClose();
  }

  #sendClose(): void {
    void invoke('native_socket_close', {
      id: this.#id,
      code: this.#closeWith?.code ?? null,
      reason: this.#closeWith?.reason ?? null,
    }).catch(() => this.#closed(1006, ''));
  }

  #closed(code: number, reason: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

/** The server's WebSocket: through the app for servers that need it, else the webview's. */
export function openServerSocket(url: string): WebSocket | NativeSocket {
  return usesNativeTransport(url) ? new NativeSocket(url) : new WebSocket(url);
}
