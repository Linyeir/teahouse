import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  app: true,
  calls: [] as unknown[],
  answer: (_request: unknown): unknown => ({ status: 200, headers: [], body: '' }),
  /** Other commands, by name: the socket ones. */
  commands: [] as { command: string; args: Record<string, unknown> }[],
  socketOpen: (): Promise<number> => Promise.resolve(7),
  channels: [] as { onmessage: (event: unknown) => void }[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${encodeURIComponent(path)}`,
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
    constructor() {
      native.channels.push(this);
    }
  },
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === 'native_fetch') {
      native.calls.push(args.request);
      const answer = native.answer(args.request);
      if (answer instanceof Error || (answer as { kind?: string }).kind) throw answer;
      return answer;
    }
    native.commands.push({ command, args });
    if (command === 'native_socket_open') return native.socketOpen();
    return null;
  }),
}));
vi.mock('./platform.ts', () => ({
  get isApp() {
    return native.app;
  },
}));

const {
  assetSrc,
  NativeSocket,
  openServerSocket,
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
  native.commands = [];
  native.channels = [];
  native.socketOpen = () => Promise.resolve(7);
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

describe('NativeSocket', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const emit = (event: unknown) => native.channels[0]?.onmessage(event);
  const record = (socket: InstanceType<typeof NativeSocket>) => {
    const seen: string[] = [];
    socket.onopen = () => seen.push('open');
    socket.onmessage = (message) => seen.push(`message:${message.data}`);
    socket.onclose = (close) => seen.push(`close:${close.code}:${close.reason}`);
    return seen;
  };

  it('opens through the app and holds early messages until it is open', async () => {
    let open: (id: number) => void = () => {};
    native.socketOpen = () => new Promise((resolve) => (open = resolve));
    const socket = new NativeSocket('wss://teahouse.lan/api/ws?token=t');
    const seen = record(socket);
    expect(native.commands[0]).toMatchObject({
      command: 'native_socket_open',
      args: { url: 'wss://teahouse.lan/api/ws?token=t' },
    });
    expect(socket.readyState).toBe(WebSocket.CONNECTING);

    emit({ type: 'message', data: 'early' });
    open(7);
    await tick();
    emit({ type: 'message', data: 'later' });
    expect(seen).toEqual(['open', 'message:early', 'message:later']);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('passes the close code on, as when a device is signed out', async () => {
    const socket = new NativeSocket('wss://teahouse.lan/api/ws');
    const seen = record(socket);
    await tick();
    emit({ type: 'close', code: 4401, reason: 'signed out' });
    expect(seen).toEqual(['open', 'close:4401:signed out']);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('sends and closes through the app', async () => {
    const socket = new NativeSocket('wss://teahouse.lan/api/ws');
    await tick();
    socket.send('hi');
    socket.close();
    expect(socket.readyState).toBe(WebSocket.CLOSING);
    expect(native.commands.slice(1)).toEqual([
      { command: 'native_socket_send', args: { id: 7, data: 'hi' } },
      { command: 'native_socket_close', args: { id: 7, code: null, reason: null } },
    ]);
  });

  it('closes a socket closed while it was still connecting, without opening it', async () => {
    let open: (id: number) => void = () => {};
    native.socketOpen = () => new Promise((resolve) => (open = resolve));
    const socket = new NativeSocket('wss://teahouse.lan/api/ws');
    const seen = record(socket);
    socket.close();
    open(7);
    await tick();
    expect(native.commands.at(-1)).toEqual({
      command: 'native_socket_close',
      args: { id: 7, code: null, reason: null },
    });
    expect(seen).not.toContain('open');
    expect(() => socket.send('late')).toThrow();
  });

  it('reports a failed open as an abnormal close', async () => {
    native.socketOpen = () =>
      Promise.reject({ kind: 'untrusted', certificate: { sha256: 'AB' }, pinned: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = new NativeSocket('wss://teahouse.lan/api/ws');
    const seen = record(socket);
    await tick();
    expect(seen).toEqual(['close:1006:']);
    expect(warn.mock.calls[0]?.[1]).toBeInstanceOf(UntrustedCertificateError);
    warn.mockRestore();
  });

  it('is used only for servers switched to the native transport', () => {
    const fake = vi.fn();
    vi.stubGlobal(
      'WebSocket',
      Object.assign(fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }),
    );
    openServerSocket('wss://teahouse.lan/api/ws');
    expect(fake).toHaveBeenCalledWith('wss://teahouse.lan/api/ws');
    setNativeTransport('https://teahouse.lan', true);
    expect(openServerSocket('wss://teahouse.lan/api/ws')).toBeInstanceOf(NativeSocket);
    expect(fake).toHaveBeenCalledTimes(1);
  });
});

describe('assetSrc', () => {
  const image = `${SERVER}/api/worlds/w1/assets/backgrounds/harbor-1.png?token=t`;

  it('loads images of other servers directly', () => {
    expect(assetSrc(image)).toBe(image);
  });

  it('loads images of servers on the native transport through the app', () => {
    setNativeTransport(SERVER, true);
    expect(assetSrc(image)).toBe(`teahouse-asset://localhost/${encodeURIComponent(image)}`);
  });
});
