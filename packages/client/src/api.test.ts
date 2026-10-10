import { describe, expect, it, vi } from 'vitest';

// offline.ts listens for the browser's offline event as soon as it loads.
vi.hoisted(() => vi.stubGlobal('window', new EventTarget()));
vi.mock('./localNetwork.ts', () => ({ ensureLocalNetwork: vi.fn(async () => false) }));

const { api } = await import('./api.ts');
const { NetworkError } = await import('./offline.ts');

describe('request', () => {
  it('fails at once when the local network is not allowed', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(api.get('/api/auth/status')).rejects.toBeInstanceOf(NetworkError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
