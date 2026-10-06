import type { SyncChanges } from '@teahouse/shared';
import { eq, gte, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { chats, memoryNodes, messages, scenes } from '../db/schema.ts';
import { now } from '../time.ts';
import { type Services, typed } from './context.ts';

/**
 * Change feed for the clients' local copies (concept, section 9). The server stays
 * authoritative: clients learn which chats changed and fetch them through the normal API.
 * Only chats and their Active Memory are synced, never canon files.
 */
export async function syncRoutes(app: FastifyInstance, { db }: Services) {
  const r = typed(app);

  r.get(
    '/api/sync/changes',
    { schema: { querystring: z.object({ since: z.string().max(40).optional() }) } },
    async ({ query }): Promise<SyncChanges> => {
      // Taken before reading, and compared with >=, so a write in the same millisecond is
      // reported twice rather than never.
      const cursor = now();
      const since = query.since;
      const all = db.select({ id: chats.id, deletedAt: chats.deletedAt }).from(chats);
      const rows = since ? all.where(gte(chats.updatedAt, since)).all() : all.all();

      const changed = new Set(rows.filter((c) => !c.deletedAt).map((c) => c.id));
      const deleted = rows.filter((c) => c.deletedAt).map((c) => c.id);
      if (since) {
        // Edits, generations and summaries touch these rows without touching the chat row.
        const touched = [
          ...db
            .selectDistinct({ id: messages.chatId })
            .from(messages)
            .where(gte(messages.updatedAt, since))
            .all(),
          ...db
            .selectDistinct({ id: scenes.chatId })
            .from(scenes)
            .where(gte(scenes.updatedAt, since))
            .all(),
          ...db
            .selectDistinct({ id: scenes.chatId })
            .from(memoryNodes)
            .innerJoin(scenes, eq(memoryNodes.sceneId, scenes.id))
            .where(gte(memoryNodes.updatedAt, since))
            .all(),
        ];
        const gone = new Set(
          db
            .select({ id: chats.id })
            .from(chats)
            .where(isNotNull(chats.deletedAt))
            .all()
            .map((c) => c.id),
        );
        for (const { id } of touched) if (!gone.has(id)) changed.add(id);
      }
      return { cursor, chats: [...changed], deleted };
    },
  );
}
