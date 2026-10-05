import rateLimit from '@fastify/rate-limit';
import { credentialsInput, type device, id } from '@teahouse/shared';
import { desc, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  checkPassword,
  isPasswordSet,
  issueDeviceToken,
  revokeDevice,
  setPassword,
} from '../auth/tokens.ts';
import { devices } from '../db/schema.ts';
import { HttpError, notFound, type Services, typed } from './context.ts';

export async function authRoutes(app: FastifyInstance, { db }: Services) {
  const r = typed(app);

  r.get('/api/auth/status', { config: { public: true } }, async () => ({
    passwordSet: isPasswordSet(db),
  }));

  await app.register(async (limited) => {
    await limited.register(rateLimit, { max: 10, timeWindow: '1 minute' });
    const l = typed(limited);

    l.post(
      '/api/auth/setup',
      { config: { public: true }, schema: { body: credentialsInput } },
      async ({ body }) => {
        if (isPasswordSet(db)) throw new HttpError(409, 'already_set_up', 'Password already set');
        await setPassword(db, body.password);
        return issueDeviceToken(db, body.deviceName);
      },
    );

    l.post(
      '/api/auth/login',
      { config: { public: true }, schema: { body: credentialsInput } },
      async ({ body }) => {
        if (!(await checkPassword(db, body.password))) {
          throw new HttpError(401, 'invalid_password', 'Wrong password');
        }
        return issueDeviceToken(db, body.deviceName);
      },
    );
  });

  r.post('/api/auth/logout', async (req) => {
    revokeDevice(db, req.deviceId);
    return { ok: true };
  });

  r.get(
    '/api/devices',
    async (req): Promise<z.infer<typeof device>[]> =>
      db
        .select()
        .from(devices)
        .where(isNull(devices.revokedAt))
        .orderBy(desc(devices.createdAt))
        .all()
        .map((d) => ({
          id: d.id,
          name: d.name,
          createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt,
          current: d.id === req.deviceId,
        })),
  );

  r.delete('/api/devices/:id', { schema: { params: z.object({ id }) } }, async ({ params }) => {
    if (!revokeDevice(db, params.id)) throw notFound('Device');
    return { ok: true };
  });
}
