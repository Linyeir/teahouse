import { API_VERSION, TEAHOUSE_VERSION } from '@teahouse/shared';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.ts';

describe('GET /api/version', () => {
  it('reports the version and API version without a token', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ url: '/api/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: TEAHOUSE_VERSION, api: API_VERSION });
    expect(TEAHOUSE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
