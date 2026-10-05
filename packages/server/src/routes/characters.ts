import { type Character, characterInput, id } from '@teahouse/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { characters } from '../db/schema.ts';
import { newId, now } from '../time.ts';
import { notFound, type Services, typed } from './context.ts';

const toCharacter = (row: typeof characters.$inferSelect): Character => ({
  id: row.id,
  name: row.name,
  description: row.description,
  firstMessage: row.firstMessage,
  updatedAt: row.updatedAt,
});

const params = z.object({ id });

export async function characterRoutes(app: FastifyInstance, { db }: Services) {
  const r = typed(app);
  const getRow = (characterId: string) =>
    db
      .select()
      .from(characters)
      .where(and(eq(characters.id, characterId), isNull(characters.deletedAt)))
      .get();

  r.get('/api/characters', async () =>
    db
      .select()
      .from(characters)
      .where(isNull(characters.deletedAt))
      .orderBy(characters.name)
      .all()
      .map(toCharacter),
  );

  r.post('/api/characters', { schema: { body: characterInput } }, async ({ body }) => {
    const timestamp = now();
    const row = db
      .insert(characters)
      .values({ ...body, id: newId(), createdAt: timestamp, updatedAt: timestamp })
      .returning()
      .get();
    return toCharacter(row);
  });

  r.put('/api/characters/:id', { schema: { params, body: characterInput } }, async (req) => {
    const existing = getRow(req.params.id);
    if (!existing) throw notFound('Character');
    const row = db
      .update(characters)
      .set({ ...req.body, updatedAt: now(), revision: existing.revision + 1 })
      .where(eq(characters.id, existing.id))
      .returning()
      .get();
    if (!row) throw notFound('Character');
    return toCharacter(row);
  });

  r.delete('/api/characters/:id', { schema: { params } }, async ({ params }) => {
    const existing = getRow(params.id);
    if (!existing) throw notFound('Character');
    const timestamp = now();
    db.update(characters)
      .set({ deletedAt: timestamp, updatedAt: timestamp, revision: existing.revision + 1 })
      .where(eq(characters.id, existing.id))
      .run();
    return { ok: true };
  });
}
