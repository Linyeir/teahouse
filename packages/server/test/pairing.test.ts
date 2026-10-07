import { describe, expect, it } from 'vitest';
import { normalizeCode, PAIRING_TTL_MS, Pairing } from '../src/auth/pairing.ts';
import { createTestApp } from './helpers.ts';

describe('pairing codes', () => {
  it('are single-use, expire and accept sloppy typing', () => {
    let time = 0;
    const pairing = new Pairing(() => time);
    const { code } = pairing.create('a');
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);

    const typed = `${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`;
    expect(pairing.claim(typed)).toBe(true);
    expect(pairing.claim(code)).toBe(false);

    const late = pairing.create('a').code;
    time += PAIRING_TTL_MS;
    expect(pairing.claim(late)).toBe(false);

    const revoked = pairing.create('b').code;
    pairing.revokeFrom('b');
    expect(pairing.claim(revoked)).toBe(false);
    expect(normalizeCode('o1 il')).toBe('0111');
  });

  it('let a new device sign in without the password', async () => {
    const { app, api } = await createTestApp();
    const { body: pairing } = await api<{ code: string; expiresAt: string }>(
      'POST',
      '/api/pairing',
    );
    const claim = (code: string) =>
      app.inject({
        method: 'POST',
        url: '/api/pairing/claim',
        body: { code, deviceName: 'Phone' },
      });

    const claimed = await claim(pairing.code);
    expect(claimed.statusCode).toBe(200);
    const { token } = claimed.json<{ token: string }>();
    const chats = await app.inject({
      url: '/api/chats',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(chats.statusCode).toBe(200);

    const reused = await claim(pairing.code);
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toMatchObject({ error: 'invalid_code' });

    const devices = await api<{ name: string }[]>('GET', '/api/devices');
    expect(devices.body.map((d) => d.name).sort()).toEqual(['Phone', 'test']);
  });

  it('needs a signed-in device to create codes', async () => {
    const { app } = await createTestApp();
    expect((await app.inject({ method: 'POST', url: '/api/pairing' })).statusCode).toBe(401);
  });

  it('lists network addresses', async () => {
    const { api } = await createTestApp();
    const { body } = await api<{ addresses: string[] }>('GET', '/api/pairing/addresses');
    for (const address of body.addresses) expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe('app access', () => {
  it('answers CORS preflights from the Tauri apps only', async () => {
    const { app } = await createTestApp();
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/api/chats',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
    const tauri = await preflight('http://tauri.localhost');
    expect(tauri.statusCode).toBe(204);
    expect(tauri.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
    const other = await preflight('https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('closes the live connection of a signed-out device', async () => {
    const { app, api } = await createTestApp();
    const { body: pairing } = await api<{ code: string }>('POST', '/api/pairing');
    const phone = (
      await app.inject({
        method: 'POST',
        url: '/api/pairing/claim',
        body: { code: pairing.code, deviceName: 'Phone' },
      })
    ).json<{ token: string; deviceId: string }>();

    const socket = await app.injectWS(`/api/ws?token=${phone.token}`);
    const closed = new Promise<number>((resolve) => socket.on('close', resolve));
    await api('DELETE', `/api/devices/${phone.deviceId}`);
    expect(await closed).toBe(4401);
  });
});
