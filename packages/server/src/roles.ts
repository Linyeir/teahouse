import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { profiles } from './db/schema.ts';
import { getSettings } from './settings.ts';

export type Role = 'narrator' | 'summary' | 'canon' | 'scene';
export type ProfileRow = typeof profiles.$inferSelect;

export class NoProfileError extends Error {
  constructor(role: Role) {
    super(`No profile is configured for the ${role} role`);
  }
}

/** Profile for a role: its own setting, else the narrator's, else the first profile. */
export function profileFor(db: Db, role: Role): ProfileRow {
  const settings = getSettings(db);
  const own = {
    narrator: settings.narratorProfileId,
    summary: settings.summaryProfileId,
    canon: settings.canonProfileId,
    scene: settings.sceneProfileId,
  }[role];
  for (const profileId of [own, settings.narratorProfileId]) {
    if (!profileId) continue;
    const row = db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, profileId), isNull(profiles.deletedAt)))
      .get();
    if (row) return row;
  }
  const first = db
    .select()
    .from(profiles)
    .where(isNull(profiles.deletedAt))
    .orderBy(profiles.createdAt)
    .get();
  if (!first) throw new NoProfileError(role);
  return first;
}
