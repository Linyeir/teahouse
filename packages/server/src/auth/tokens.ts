import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { devices } from '../db/schema.ts';
import { getSetting, setSetting } from '../settings.ts';
import { newId, now } from '../time.ts';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const isPasswordSet = (db: Db) => typeof getSetting(db, 'passwordHash') === 'string';

export async function setPassword(db: Db, password: string): Promise<void> {
  setSetting(db, 'passwordHash', await hash(password));
}

export async function checkPassword(db: Db, password: string): Promise<boolean> {
  const stored = getSetting(db, 'passwordHash');
  return typeof stored === 'string' && verify(stored, password);
}

export function issueDeviceToken(db: Db, deviceName: string): { token: string; deviceId: string } {
  const token = randomBytes(32).toString('base64url');
  const deviceId = newId();
  db.insert(devices)
    .values({ id: deviceId, name: deviceName, tokenHash: hashToken(token), createdAt: now() })
    .run();
  return { token, deviceId };
}

/** Returns the device ID for a valid, unrevoked token. */
export function resolveToken(db: Db, token: string): string | null {
  const device = db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.tokenHash, hashToken(token)), isNull(devices.revokedAt)))
    .get();
  if (!device) return null;
  db.update(devices).set({ lastSeenAt: now() }).where(eq(devices.id, device.id)).run();
  return device.id;
}

export function revokeDevice(db: Db, deviceId: string): boolean {
  const result = db
    .update(devices)
    .set({ revokedAt: now() })
    .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)))
    .run();
  return result.changes > 0;
}
