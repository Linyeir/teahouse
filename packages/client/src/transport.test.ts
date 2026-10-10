import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  app: true,
  calls: [] as unknown[],
  answer: (_request: unknown): unknown => ({ status: 200, headers: [], body: '' }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_command: string, args: { request: unknown }) => {
    native.calls.push(args.request);
    const answer = native.answer(args.request);
    if (answer instanceof Error || (answer as { kind?: string }).kind) throw answer;
    return answer;
  }),
}));
vi.mock('./platform.ts', () => ({
  get isApp() {
    return native.app;
  },
}));

const {
  originOf,
  serverFetch,
  setNativeTransport,
  usesNativeTransport,
  UntrustedCertificateError,
} = await import('./transport.ts');

const SERVER = 'https://teahouse.lan';
const decode = (base64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  native.app = true;
  native.calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which requests go through the app', () => {
  it('keys servers by origin, port included', () => {
    expect(originOf('https://teahouse.lan/api/x')).toBe('https://teahouse.lan:443');
    expect(originOf('https://10.0.0.2:8443')).toBe('https://10.0.0.2:8443');
    expect(originOf('http://teahouse.lan')).toBeNull();
    expect(originOf('/api/chats')).toBeNull();
  });

  it('only servers switched to it, only https, only in the app', () => {
    expect(usesNativeTransport(`${SERVER}/api/chats`)).toBe(false);
    setNativeTransport(SERVER, true);
    expect(usesNativeTransport(`${SERVER}/api/chats`)).toBe(true);
    expect(usesNativeTransport('https://teahouse.lan:8443/api/chats')).toBe(false);
    setNativeTransport('http://teahouse.lan', true);
    expect(usesNativeTransport('http://teahouse.lan/api')).toBe(false);
    native.app = false;
    expect(usesNativeTransport(`${SERVER}/api/chats`)).toBe(false);
    native.app = true;
    setNativeTransport(SERVER, false);
    expect(usesNativeTransport(`${SERVER}/api/chats`)).toBe(false);
  });
});

describe('serverFetch', () => {
  it('uses the webview for other servers', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await serverFetch(`${SERVER}/api/chats`, { method: 'GET' });
    expect(fetch).toHaveBeenCalledWith(`${SERVER}/api/chats`, { method: 'GET' });
    expect(native.calls).toEqual([]);
  });

  it('sends method, headers and a JSON body through the app', async () => {
    setNativeTransport(SERVER, true);
    native.answer = () => ({
      status: 201,
      headers: [['content-type', 'application/json']],
      body: encode('{"id":"w1"}'),
    });
    const response = await serverFetch(`${SERVER}/api/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ name: 'Rain Port' }),
    });

    const request = native.calls[0] as {
      url: string;
      method: string;
      headers: [string, string][];
      body: string;
    };
    expect(request.url).toBe(`${SERVER}/api/worlds`);
    expect(request.method).toBe('POST');
    expect(request.headers).toContainEqual(['authorization', 'Bearer t']);
    expect(request.headers).toContainEqual(['content-type', 'application/json']);
    expect(JSON.parse(decode(request.body))).toEqual({ name: 'Rain Port' });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ id: 'w1' });
  });

  it('encodes uploads as multipart with their boundary', async () => {
    setNativeTransport(SERVER, true);
    const form = new FormData();
    form.set('description', 'harbor');
    form.set('file', new Blob(['PNGDATA'], { type: 'image/png' }), 'harbor.png');
    await serverFetch(`${SERVER}/api/worlds/w1/backgrounds`, { method: 'POST', body: form });

    const request = native.calls[0] as { headers: [string, string][]; body: string };
    const type = new Headers(request.headers).get('content-type') ?? '';
    const boundary = /boundary=(.+)$/.exec(type)?.[1];
    expect(type).toMatch(/^multipart\/form-data; boundary=/);
    const body = decode(request.body);
    expect(body).toContain(`--${boundary}`);
    expect(body).toContain('name="description"');
    expect(body).toContain('filename="harbor.png"');
    expect(body).toContain('PNGDATA');
  });

  it('reports an untrusted certificate for the user to accept', async () => {
    setNativeTransport(SERVER, true);
    const certificate = { sha256: 'AB:CD', selfSigned: true };
    native.answer = () => ({ kind: 'untrusted', certificate, pinned: true });
    const error = await serverFetch(`${SERVER}/api/chats`).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UntrustedCertificateError);
    expect((error as InstanceType<typeof UntrustedCertificateError>).certificate).toBe(certificate);
    expect((error as InstanceType<typeof UntrustedCertificateError>).pinned).toBe(true);
  });

  it('fails like fetch when the server cannot be reached', async () => {
    setNativeTransport(SERVER, true);
    native.answer = () => ({ kind: 'network', message: 'connection refused' });
    await expect(serverFetch(`${SERVER}/api/chats`)).rejects.toThrow(TypeError);
  });

  it('gives bodiless statuses no body', async () => {
    setNativeTransport(SERVER, true);
    native.answer = () => ({ status: 204, headers: [], body: '' });
    const response = await serverFetch(`${SERVER}/api/chats/c1`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});
