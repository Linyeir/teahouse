import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.ts';

describe('auth', () => {
  it('sets up once and issues device tokens', async () => {
    const { app, api } = await createTestApp();

    const status = await app.inject({ url: '/api/auth/status' });
    expect(status.json()).toEqual({ passwordSet: true });

    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      body: { password: 'another password', deviceName: 'x' },
    });
    expect(again.statusCode).toBe(409);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      body: { password: 'wrong password', deviceName: 'x' },
    });
    expect(wrong.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      body: { password: 'correct horse', deviceName: 'phone' },
    });
    expect(login.statusCode).toBe(200);

    const devices = await api<{ name: string; current: boolean }[]>('GET', '/api/devices');
    expect(devices.body.map((d) => d.name).sort()).toEqual(['phone', 'test']);
  });

  it('rejects requests without a valid token', async () => {
    const { app, token } = await createTestApp();
    expect((await app.inject({ url: '/api/chats' })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: '/api/chats', headers })).statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect((await app.inject({ url: '/api/chats', headers })).statusCode).toBe(401);
  });
});
