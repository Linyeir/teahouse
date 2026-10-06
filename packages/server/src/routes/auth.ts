import { networkInterfaces } from 'node:os';
import rateLimit from '@fastify/rate-limit';
import {
  credentialsInput,
  type device,
  id,
  type PairingCode,
  pairingClaimInput,
  type ServerAddresses,
} from '@teahouse/shared';
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

/** Non-internal IPv4 addresses, for pairing a phone when the browser shows `localhost`. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i?.address ?? '')
    .filter(Boolean);
}

export async function authRoutes(app: FastifyInstance, { db, hub, pairing }: Services) {
  const r = typed(app);
  const signOut = (deviceId: string) => {
    const revoked = revokeDevice(db, deviceId);
    pairing.revokeFrom(deviceId);
    hub.disconnect(deviceId);
    hub.broadcast({ type: 'devices.changed' });
    return revoked;
  };
  const signIn = (deviceName: string) => {
    const issued = issueDeviceToken(db, deviceName);
    hub.broadcast({ type: 'devices.changed' });
    return issued;
  };

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
        return signIn(body.deviceName);
      },
    );

    l.post(
      '/api/auth/login',
      { config: { public: true }, schema: { body: credentialsInput } },
      async ({ body }) => {
        if (!(await checkPassword(db, body.password))) {
          throw new HttpError(401, 'invalid_password', 'Wrong password');
        }
        return signIn(body.deviceName);
      },
    );

    // Rate-limited like login: a pairing code is a short-lived password.
    l.post(
      '/api/pairing/claim',
      { config: { public: true }, schema: { body: pairingClaimInput } },
      async ({ body }) => {
        if (!pairing.claim(body.code)) {
          throw new HttpError(401, 'invalid_code', 'Pairing code is invalid or expired');
        }
        return signIn(body.deviceName);
      },
    );
  });

  r.post('/api/pairing', async (req): Promise<PairingCode> => pairing.create(req.deviceId));

  r.get(
    '/api/pairing/addresses',
    async (): Promise<ServerAddresses> => ({ addresses: lanAddresses() }),
  );

  r.post('/api/auth/logout', async (req) => {
    signOut(req.deviceId);
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
    if (!signOut(params.id)) throw notFound('Device');
    return { ok: true };
  });
}
