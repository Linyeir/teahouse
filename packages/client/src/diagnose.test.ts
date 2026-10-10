import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  probe: { result: 'notTls' } as unknown,
  localNetwork: 'granted',
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => native.probe),
  checkPermissions: vi.fn(async () => ({ localNetwork: native.localNetwork })),
  requestPermissions: vi.fn(async () => ({ localNetwork: native.localNetwork })),
}));
vi.mock('./platform.ts', () => ({ isApp: true, isAndroidApp: true }));

const { diagnose } = await import('./diagnose.ts');

const certificate = {
  subject: 'CN=teahouse.lan',
  issuer: 'CN=Teahouse Test CA',
  notBefore: 1_790_000_000,
  notAfter: 1_800_000_000,
  sha256: 'AB:CD',
  selfSigned: false,
  matchesHost: true,
};

/** `cors` and `no-cors` answer as given; null means the webview could not connect. */
function webview(cors: number | null, noCors: boolean) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.mode === 'no-cors') {
      if (noCors) return new Response(null);
      throw new TypeError('Failed to fetch');
    }
    if (cors === null) throw new TypeError('Failed to fetch');
    return new Response(null, { status: cors });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('diagnose', () => {
  beforeEach(() => {
    native.probe = { result: 'notTls' };
    native.localNetwork = 'granted';
  });

  it('reports a server that answers again', async () => {
    webview(200, true);
    expect(await diagnose('https://teahouse.example.com')).toEqual({ kind: 'reachable' });
  });

  it('reports a proxy whose server is down', async () => {
    webview(502, true);
    expect(await diagnose('https://teahouse.example.com')).toEqual({ kind: 'gateway' });
  });

  it('reports a response the webview may not read (CORS, redirect)', async () => {
    webview(null, true);
    expect(await diagnose('https://teahouse.example.com')).toEqual({ kind: 'blocked' });
  });

  it('reports an untrusted certificate when the native handshake works', async () => {
    webview(null, false);
    native.probe = { result: 'tls', certificate };
    expect(await diagnose('https://teahouse.example.com')).toEqual({
      kind: 'untrusted',
      certificate,
    });
  });

  it('reports a failed handshake', async () => {
    webview(null, false);
    native.probe = { result: 'tlsFailed', reason: 'wrong version', certificate: null };
    expect(await diagnose('https://teahouse.example.com:8787')).toEqual({
      kind: 'tlsFailed',
      reason: 'wrong version',
    });
  });

  it('reports a server that is down, with the reason', async () => {
    webview(null, false);
    native.probe = { result: 'unreachable', reason: 'Connection refused' };
    expect(await diagnose('https://teahouse.example.com')).toEqual({
      kind: 'unreachable',
      reason: 'Connection refused',
    });
  });

  it('blames the missing permission for a local server without asking the network', async () => {
    const fetch = webview(null, false);
    native.localNetwork = 'denied';
    expect(await diagnose('http://192.168.1.10:8787')).toEqual({ kind: 'localNetwork' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blames the missing permission when a domain cannot be reached either', async () => {
    webview(null, false);
    native.localNetwork = 'denied';
    native.probe = { result: 'unreachable', reason: 'timed out' };
    expect(await diagnose('https://teahouse.example.com')).toEqual({ kind: 'localNetwork' });
  });

  it('does not blame the permission when the native handshake works', async () => {
    webview(null, false);
    native.localNetwork = 'denied';
    native.probe = { result: 'tls', certificate };
    expect((await diagnose('https://teahouse.example.com')).kind).toBe('untrusted');
  });
});
