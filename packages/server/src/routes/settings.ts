import { settings } from '@teahouse/shared';
import type { FastifyInstance } from 'fastify';
import { getSettings, saveSettings } from '../settings.ts';
import { type Services, typed } from './context.ts';

export async function settingsRoutes(app: FastifyInstance, { db }: Services) {
  const r = typed(app);
  r.get('/api/settings', async () => getSettings(db));
  r.put('/api/settings', { schema: { body: settings } }, async ({ body }) =>
    saveSettings(db, body),
  );
}
