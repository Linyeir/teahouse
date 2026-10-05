import {
  type ChatPath,
  chatInput,
  editMessageInput,
  id,
  selectLeafInput,
  sendMessageInput,
} from '@teahouse/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { characters, chats, messages } from '../db/schema.ts';
import { GenerationError } from '../generation.ts';
import { newId, now } from '../time.ts';
import { activePath, deepestLeaf, getChatRow, getMessageRow, toChat, toMessage } from '../tree.ts';
import { HttpError, notFound, type Services, typed } from './context.ts';

const params = z.object({ id });

function chatPath(db: Db, chatId: string): ChatPath {
  const chat = getChatRow(db, chatId);
  if (!chat) throw notFound('Chat');
  return { chat: toChat(chat), messages: activePath(db, chatId, chat.activeLeafId) };
}

const generationHttpError = (err: unknown) => {
  if (!(err instanceof GenerationError)) return err;
  const status = { no_profile: 409, busy: 409, not_found: 404 }[err.code];
  return new HttpError(status, err.code, err.message);
};

export async function chatRoutes(app: FastifyInstance, { db, hub, generator }: Services) {
  const r = typed(app);
  const changed = (chatId: string) => hub.broadcast({ type: 'chat.changed', chatId });

  const startGeneration = (chatId: string, parentId: string | null) => {
    try {
      return generator.start(chatId, parentId);
    } catch (err) {
      throw generationHttpError(err);
    }
  };

  r.get('/api/chats', async () =>
    db
      .select()
      .from(chats)
      .where(isNull(chats.deletedAt))
      .orderBy(desc(chats.updatedAt))
      .all()
      .map(toChat),
  );

  r.post('/api/chats', { schema: { body: chatInput } }, async ({ body }) => {
    const character = db
      .select()
      .from(characters)
      .where(and(eq(characters.id, body.characterId), isNull(characters.deletedAt)))
      .get();
    if (!character) throw notFound('Character');

    const timestamp = now();
    const chatId = newId();
    const greetingId = character.firstMessage.trim() ? newId() : null;
    db.transaction((tx) => {
      tx.insert(chats)
        .values({
          id: chatId,
          title: body.title?.trim() || character.name,
          characterId: character.id,
          activeLeafId: greetingId,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      if (greetingId) {
        tx.insert(messages)
          .values({
            id: greetingId,
            chatId,
            parentId: null,
            role: 'assistant',
            content: character.firstMessage,
            status: 'complete',
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .run();
      }
    });
    return chatPath(db, chatId);
  });

  r.get('/api/chats/:id', { schema: { params } }, async ({ params }) => chatPath(db, params.id));

  r.patch(
    '/api/chats/:id',
    { schema: { params, body: z.object({ title: z.string().min(1).max(200) }) } },
    async ({ params, body }) => {
      const chat = getChatRow(db, params.id);
      if (!chat) throw notFound('Chat');
      db.update(chats)
        .set({ title: body.title, updatedAt: now(), revision: chat.revision + 1 })
        .where(eq(chats.id, chat.id))
        .run();
      changed(chat.id);
      return chatPath(db, chat.id);
    },
  );

  r.delete('/api/chats/:id', { schema: { params } }, async ({ params }) => {
    const chat = getChatRow(db, params.id);
    if (!chat) throw notFound('Chat');
    const timestamp = now();
    db.update(chats)
      .set({ deletedAt: timestamp, updatedAt: timestamp, revision: chat.revision + 1 })
      .where(eq(chats.id, chat.id))
      .run();
    changed(chat.id);
    return { ok: true };
  });

  r.post(
    '/api/chats/:id/messages',
    { schema: { params, body: sendMessageInput } },
    async ({ params, body }) => {
      const chat = getChatRow(db, params.id);
      if (!chat) throw notFound('Chat');
      if (generator.isBusy(chat.id)) {
        throw new HttpError(409, 'busy', 'A reply is already being generated');
      }

      const messageId = body.id ?? newId();
      // A retried request with the same client ID must not create a second message.
      if (!getMessageRow(db, messageId)) {
        const timestamp = now();
        db.transaction((tx) => {
          tx.insert(messages)
            .values({
              id: messageId,
              chatId: chat.id,
              parentId: chat.activeLeafId,
              role: 'user',
              content: body.content,
              status: 'complete',
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .run();
          tx.update(chats)
            .set({ activeLeafId: messageId, updatedAt: timestamp })
            .where(eq(chats.id, chat.id))
            .run();
        });
        changed(chat.id);
      }
      return { messageId: startGeneration(chat.id, messageId).id };
    },
  );

  /** Generates a reply to the active leaf, e.g. after a failed request. */
  r.post('/api/chats/:id/generate', { schema: { params } }, async ({ params }) => {
    const chat = getChatRow(db, params.id);
    if (!chat) throw notFound('Chat');
    return { messageId: startGeneration(chat.id, chat.activeLeafId).id };
  });

  r.post('/api/chats/:id/leaf', { schema: { params, body: selectLeafInput } }, async (req) => {
    const chat = getChatRow(db, req.params.id);
    const target = getMessageRow(db, req.body.messageId);
    if (!chat || target?.chatId !== chat.id) throw notFound('Message');
    db.update(chats)
      .set({ activeLeafId: deepestLeaf(db, chat.id, req.body.messageId), updatedAt: now() })
      .where(eq(chats.id, chat.id))
      .run();
    changed(chat.id);
    return chatPath(db, chat.id);
  });

  r.post('/api/messages/:id/regenerate', { schema: { params } }, async ({ params }) => {
    const message = getMessageRow(db, params.id);
    if (message?.role !== 'assistant') throw notFound('Assistant message');
    return { messageId: startGeneration(message.chatId, message.parentId).id };
  });

  r.post('/api/messages/:id/stop', { schema: { params } }, async ({ params }) => ({
    stopped: generator.stop(params.id),
  }));

  r.put(
    '/api/messages/:id',
    { schema: { params, body: editMessageInput } },
    async ({ params, body }) => {
      const message = getMessageRow(db, params.id);
      if (!message) throw notFound('Message');
      if (message.status === 'streaming') {
        throw new HttpError(409, 'busy', 'The message is still being generated');
      }
      const row = db
        .update(messages)
        .set({ content: body.content, updatedAt: now(), revision: message.revision + 1 })
        .where(eq(messages.id, message.id))
        .returning()
        .get();
      changed(message.chatId);
      return row ? toMessage(row) : null;
    },
  );
}
