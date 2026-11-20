import { describe, expect, it } from 'vitest';
import { isApiRoute } from '../src/app.ts';
import { createTestApp } from './helpers.ts';

const ID = '01900000-0000-7000-8000-000000000000';

describe('perimeter', () => {
  it('requires a device token on every API route that is not marked public', async () => {
    const { app } = await createTestApp();
    const routes = app.routeTable.filter((r) => isApiRoute(r.url) && !r.public);
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      const url = route.url.replace(/:[A-Za-z]+/g, ID);
      for (const method of [route.method].flat()) {
        if (method === 'HEAD') continue;
        const res = await app.inject({ method: method as 'GET', url });
        expect(res.statusCode, `${method} ${route.url}`).toBe(401);
      }
    }
  });

  it('marks only the sign-in and version routes as public', async () => {
    const { app } = await createTestApp();
    const open = app.routeTable
      .filter((r) => r.public)
      .map((r) => r.url)
      .sort();
    expect([...new Set(open)]).toEqual([
      '/api/auth/login',
      '/api/auth/setup',
      '/api/auth/status',
      '/api/pairing/claim',
      '/api/version',
    ]);
  });

  it('does not let an encoded or unusual path skip the token check', async () => {
    const { app } = await createTestApp();
    const variants = [
      '/%61pi/devices',
      '/%61%70%69/devices',
      '/api/%64evices',
      '/%2561pi/devices',
      '/API/devices',
      '/Api/devices',
      '/api//devices',
      '//api/devices',
      '/./api/devices',
      '/x/../api/devices',
      '/api/devices/',
      '/api/devices?',
      '/api/devices#x',
      '/api/devices;x',
      '/%61pi/profiles',
      '/%61pi/chats',
    ];
    for (const url of variants) {
      const res = await app.inject({ url });
      expect([401, 404], url).toContain(res.statusCode);
    }
    for (const url of ['/%61pi/pairing', '/%61pi/auth/logout']) {
      const res = await app.inject({ method: 'POST', url });
      expect([401, 404], url).toContain(res.statusCode);
    }
    const ws = await app.inject({ url: '/%61pi/ws' });
    expect([401, 404]).toContain(ws.statusCode);
  });

  it('refuses to register a route outside /api/ that is not marked public', async () => {
    const { app } = await createTestApp();
    expect(app.routeTable.every((r) => isApiRoute(r.url) || r.public)).toBe(true);
  });
});
