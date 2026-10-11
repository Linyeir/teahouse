import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  probe: { result: 'notTls' } as unknown,
  localNetwork: 'granted',
  /** What platform_trust answers; an Error makes the command fail (no native transport). */
  platformTrust: { result: 'untrusted' } as unknown,
  pins: [] as { origin: string; sha256: string }[],
  /** What native_fetch answers or throws. */
  nativeFetch: { status: 200, headers: [], body: '' } as unknown,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    const answers: Record<string, unknown> = {
      probe_server: native.probe,
      platform_trust: native.platformTrust,
      list_pins: native.pins,
      native_fetch: native.nativeFetch,
    };
    const answer = answers[command];
    if (answer instanceof Error || (answer as { kind?: string } | undefined)?.kind) throw answer;
    return answer;
  }),
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
    native.platformTrust = { result: 'untrusted' };
    native.pins = [];
    native.nativeFetch = { status: 200, headers: [], body: '' };
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
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

  it('offers the app connection when the device trusts what the webview refuses', async () => {
    webview(null, false);
    native.probe = { result: 'tls', certificate };
    native.platformTrust = { result: 'trusted' };
    expect(await diagnose('https://teahouse.lan')).toEqual({ kind: 'webviewOnly', certificate });
  });

  it('reports an untrusted certificate when the platform cannot check it', async () => {
    webview(null, false);
    native.probe = { result: 'tls', certificate };
    native.platformTrust = new Error('command platform_trust not found');
    expect(await diagnose('https://teahouse.lan')).toEqual({ kind: 'untrusted', certificate });
  });

  describe('for a server the app connects to itself', () => {
    beforeEach(() => {
      localStorage.setItem('teahouse.native', JSON.stringify(['https://teahouse.lan:443']));
    });

    it('reports a server that answers', async () => {
      const fetch = webview(null, false);
      expect(await diagnose('https://teahouse.lan')).toEqual({ kind: 'reachable' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('reports a changed certificate with the one that was trusted', async () => {
      native.pins = [{ origin: 'https://teahouse.lan:443', sha256: '11:22' }];
      native.nativeFetch = { kind: 'untrusted', certificate, pinned: true };
      expect(await diagnose('https://teahouse.lan')).toEqual({
        kind: 'certificateChanged',
        certificate,
        accepted: '11:22',
      });
    });

    it('reports an untrusted certificate when none was trusted', async () => {
      native.nativeFetch = { kind: 'untrusted', certificate, pinned: false };
      expect(await diagnose('https://teahouse.lan')).toEqual({ kind: 'untrusted', certificate });
    });

    it('asks the probe why it cannot connect', async () => {
      native.nativeFetch = { kind: 'network', message: 'refused' };
      native.probe = { result: 'unreachable', reason: 'Connection refused' };
      expect(await diagnose('https://teahouse.lan')).toEqual({
        kind: 'unreachable',
        reason: 'Connection refused',
      });
    });
  });
});
