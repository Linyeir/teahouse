import { API_VERSION } from '@teahouse/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// version.ts reaches the browser through api.ts and i18n.ts.
vi.stubGlobal('window', new EventTarget());
vi.stubGlobal('navigator', { language: 'en', userAgent: '' });
const { checkServerVersion, versionMessage } = await import('./version.ts');
const i18n = (await import('./i18n.ts')).default;

const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

describe('server version check', () => {
  beforeAll(() => i18n.changeLanguage('en'));

  it('accepts a server with the same API version', async () => {
    respond(200, { version: '9.9.9', api: API_VERSION });
    const check = await checkServerVersion();
    expect(check).toEqual({ compatibility: 'ok', server: '9.9.9' });
    expect(versionMessage(check)).toBeNull();
  });

  it('treats a server without /api/version as API version 1', async () => {
    respond(404, { error: 'not_found', message: 'Route not found' });
    expect(await checkServerVersion()).toEqual({
      compatibility: API_VERSION === 1 ? 'ok' : 'update-server',
      server: null,
    });
  });

  it('says which side to update', async () => {
    respond(200, { version: '9.0.0', api: API_VERSION + 1 });
    expect(versionMessage(await checkServerVersion())).toMatch(/Reload the page/);
    respond(200, { version: '0.1.0', api: API_VERSION - 1 });
    expect(versionMessage(await checkServerVersion())).toMatch(/server runs Teahouse 0\.1\.0/);
  });

  it('passes other errors on', async () => {
    respond(500, { error: 'internal', message: 'boom' });
    await expect(checkServerVersion()).rejects.toThrow('boom');
  });
});
