import type { Settings } from '@teahouse/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { settings } from './db/schema.ts';

const DEFAULTS: Settings = { userName: 'User', outputLanguage: 'English', narratorProfileId: null };

type Key = keyof Settings | 'passwordHash';
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function getSetting<K extends Key>(db: Db, key: K): unknown {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

/** Stores a setting; `null` removes it so the default applies. */
export function setSetting(db: Db | Tx, key: Key, value: unknown): void {
  if (value === null || value === undefined) {
    db.delete(settings).where(eq(settings.key, key)).run();
    return;
  }
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function getSettings(db: Db): Settings {
  const rows = db.select().from(settings).all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    userName: (stored.userName as string) ?? DEFAULTS.userName,
    outputLanguage: (stored.outputLanguage as string) ?? DEFAULTS.outputLanguage,
    narratorProfileId: (stored.narratorProfileId as string | null) ?? DEFAULTS.narratorProfileId,
  };
}

export function saveSettings(db: Db, next: Settings): Settings {
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(next)) setSetting(tx, key as Key, value);
  });
  return getSettings(db);
}
