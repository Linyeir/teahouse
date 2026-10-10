import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  android: true,
  /** What the permission check reports, and what a request turns it into. */
  state: 'prompt',
  answer: 'granted',
  fails: false,
}));

vi.mock('@tauri-apps/api/core', () => ({
  checkPermissions: vi.fn(async () => {
    if (native.fails) throw new Error('plugin missing');
    return { localNetwork: native.state };
  }),
  requestPermissions: vi.fn(async () => {
    native.state = native.answer;
    return { localNetwork: native.state };
  }),
  invoke: vi.fn(),
}));
vi.mock('./platform.ts', () => ({
  isApp: true,
  get isAndroidApp() {
    return native.android;
  },
}));

const { looksLocal } = await import('./localNetwork.ts');

describe('looksLocal', () => {
  it('recognises private and link-local addresses', () => {
    for (const server of [
      'http://192.168.1.10:8787',
      'http://10.0.0.5',
      'https://172.16.0.1',
      'https://172.31.255.255',
      'http://169.254.10.10',
      'http://[fd12:3456::1]:8787',
      'http://[fe80::1]',
    ]) {
      expect(looksLocal(server), server).toBe(true);
    }
  });

  it('recognises local names', () => {
    for (const server of [
      'http://teahouse:8787',
      'https://nas.local',
      'https://teahouse.lan',
      'https://teahouse.home.arpa',
      'https://box.internal',
    ]) {
      expect(looksLocal(server), server).toBe(true);
    }
  });

  it('leaves public and VPN addresses alone', () => {
    for (const server of [
      'https://teahouse.example.com',
      'https://box.tail1234.ts.net',
      'http://100.101.102.103:8787',
      'https://172.32.0.1',
      'https://8.8.8.8',
      'http://[2001:db8::1]',
      'not a url',
    ]) {
      expect(looksLocal(server), server).toBe(false);
    }
  });
});

describe('ensureLocalNetwork', () => {
  // Fresh module state (the one dialog per start) for every test.
  async function load() {
    vi.resetModules();
    const core = await import('@tauri-apps/api/core');
    const { ensureLocalNetwork } = await import('./localNetwork.ts');
    return { ensureLocalNetwork, request: vi.mocked(core.requestPermissions) };
  }

  afterEach(() => {
    Object.assign(native, { android: true, state: 'prompt', answer: 'granted', fails: false });
    vi.clearAllMocks();
  });

  it('does nothing outside the Android app and for public servers', async () => {
    const { ensureLocalNetwork, request } = await load();
    expect(await ensureLocalNetwork('https://teahouse.example.com')).toBe(true);
    native.android = false;
    expect(await ensureLocalNetwork('http://192.168.1.10:8787')).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('asks before the first request to a local server', async () => {
    const { ensureLocalNetwork, request } = await load();
    expect(await ensureLocalNetwork('http://192.168.1.10:8787')).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not ask when the permission is granted already', async () => {
    native.state = 'granted';
    const { ensureLocalNetwork, request } = await load();
    expect(await ensureLocalNetwork('http://192.168.1.10:8787')).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('asks once per start and then fails requests at once', async () => {
    native.answer = 'denied';
    const { ensureLocalNetwork, request } = await load();
    const server = 'http://192.168.1.10:8787';
    expect(await Promise.all([ensureLocalNetwork(server), ensureLocalNetwork(server)])).toEqual([
      false,
      false,
    ]);
    expect(await ensureLocalNetwork(server)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('lets requests through once the permission is granted in the settings', async () => {
    native.answer = 'denied';
    const { ensureLocalNetwork } = await load();
    expect(await ensureLocalNetwork('http://192.168.1.10:8787')).toBe(false);
    native.state = 'granted';
    expect(await ensureLocalNetwork('http://192.168.1.10:8787')).toBe(true);
  });

  it('lets requests try when the plugin cannot answer', async () => {
    native.fails = true;
    const { ensureLocalNetwork } = await load();
    expect(await ensureLocalNetwork('http://192.168.1.10:8787')).toBe(true);
  });
});
