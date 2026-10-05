import { endpointProbeInput, id, type Profile, profileInput } from '@teahouse/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { profiles } from '../db/schema.ts';
import { listModels } from '../llm/client.ts';
import { detectContextWindow } from '../llm/context-window.ts';
import { getSettings, saveSettings } from '../settings.ts';
import { newId, now } from '../time.ts';
import { HttpError, notFound, type Services, typed } from './context.ts';

type Row = typeof profiles.$inferSelect;

const toProfile = (row: Row): Profile => ({
  id: row.id,
  name: row.name,
  baseUrl: row.baseUrl,
  model: row.model,
  temperature: row.temperature,
  topP: row.topP,
  maxTokens: row.maxTokens,
  contextWindowOverride: row.contextWindowOverride,
  detectedContextWindow: row.detectedContextWindow,
  hasApiKey: Boolean(row.apiKey),
  updatedAt: row.updatedAt,
});

const getRow = (db: Db, profileId: string) =>
  db
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, profileId), isNull(profiles.deletedAt)))
    .get();

const params = z.object({ id });

export async function profileRoutes(app: FastifyInstance, { db }: Services) {
  const r = typed(app);

  /** Best effort: a profile is usable without a detected context window. */
  const detect = async (row: Row) => {
    const detected = await detectContextWindow(row, row.model);
    if (detected === row.detectedContextWindow) return row;
    return (
      db
        .update(profiles)
        .set({ detectedContextWindow: detected })
        .where(eq(profiles.id, row.id))
        .returning()
        .get() ?? row
    );
  };

  r.get('/api/profiles', async () =>
    db
      .select()
      .from(profiles)
      .where(isNull(profiles.deletedAt))
      .orderBy(profiles.createdAt)
      .all()
      .map(toProfile),
  );

  r.post('/api/profiles', { schema: { body: profileInput } }, async ({ body }) => {
    const timestamp = now();
    const row = db
      .insert(profiles)
      .values({
        ...body,
        apiKey: body.apiKey || null,
        id: newId(),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    // The first profile becomes the narrator profile.
    const settings = getSettings(db);
    if (!settings.narratorProfileId) saveSettings(db, { ...settings, narratorProfileId: row.id });
    return toProfile(await detect(row));
  });

  r.put('/api/profiles/:id', { schema: { params, body: profileInput } }, async (req) => {
    const existing = getRow(db, req.params.id);
    if (!existing) throw notFound('Profile');
    const { apiKey, ...rest } = req.body;
    const row = db
      .update(profiles)
      .set({
        ...rest,
        ...(apiKey !== undefined && { apiKey: apiKey || null }),
        updatedAt: now(),
        revision: existing.revision + 1,
      })
      .where(eq(profiles.id, existing.id))
      .returning()
      .get();
    if (!row) throw notFound('Profile');
    return toProfile(await detect(row));
  });

  r.delete('/api/profiles/:id', { schema: { params } }, async ({ params }) => {
    const existing = getRow(db, params.id);
    if (!existing) throw notFound('Profile');
    const timestamp = now();
    db.update(profiles)
      .set({ deletedAt: timestamp, updatedAt: timestamp, revision: existing.revision + 1 })
      .where(eq(profiles.id, existing.id))
      .run();
    const settings = getSettings(db);
    if (settings.narratorProfileId === existing.id) {
      saveSettings(db, { ...settings, narratorProfileId: null });
    }
    return { ok: true };
  });

  r.post('/api/profiles/:id/detect-context', { schema: { params } }, async ({ params }) => {
    const existing = getRow(db, params.id);
    if (!existing) throw notFound('Profile');
    return toProfile(await detect(existing));
  });

  r.post('/api/endpoints/models', { schema: { body: endpointProbeInput } }, async ({ body }) => {
    let apiKey = body.apiKey ?? null;
    if (apiKey === null && body.profileId) apiKey = getRow(db, body.profileId)?.apiKey ?? null;
    try {
      return { models: await listModels({ baseUrl: body.baseUrl, apiKey }) };
    } catch (err) {
      throw new HttpError(
        502,
        'endpoint_unreachable',
        err instanceof Error ? err.message : 'Endpoint did not answer',
      );
    }
  });
}
