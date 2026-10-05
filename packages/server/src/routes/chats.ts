import {
  type ChatPath,
  chatInput,
  closeSceneInput,
  editMessageInput,
  id,
  sceneProposalInput,
  sceneStartInput,
  selectLeafInput,
  sendMessageInput,
} from '@teahouse/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentScene, memoryOnPath } from '../context/turn.ts';
import type { Db } from '../db/index.ts';
import { chats, messages, scenes } from '../db/schema.ts';
import { GenerationError } from '../generation.ts';
import { toScene } from '../scenes.ts';
import { newId, now } from '../time.ts';
import { activePath, deepestLeaf, getChatRow, getMessageRow, toChat, toMessage } from '../tree.ts';
import { HttpError, notFound, type Services, typed } from './context.ts';

const params = z.object({ id });

function chatPath(db: Db, chatId: string): ChatPath {
  const chat = getChatRow(db, chatId);
  if (!chat) throw notFound('Chat');
  const all = db
    .select()
    .from(scenes)
    .where(and(eq(scenes.chatId, chatId), isNull(scenes.deletedAt)))
    .orderBy(scenes.number)
    .all();
  const current = all.at(-1);
  // A closed current scene shows its frozen path; an active one the chat's active leaf.
  const leaf = current?.status === 'active' ? chat.activeLeafId : (current?.closedLeafId ?? null);
  const messages = activePath(db, chatId, leaf);
  return {
    chat: toChat(chat),
    scene: current ? toScene(current) : null,
    messages,
    memory: current ? memoryOnPath(db, current.id, messages) : [],
    closedScenes: all.slice(0, -1).map((s) => ({
      scene: toScene(s),
      messages: activePath(db, chatId, s.closedLeafId),
    })),
  };
}

/** Messages of closed scenes are frozen. */
function assertEditable(db: Db, message: { sceneId: string | null }) {
  const scene = message.sceneId
    ? db.select().from(scenes).where(eq(scenes.id, message.sceneId)).get()
    : undefined;
  if (scene && scene.status !== 'active') {
    throw new HttpError(409, 'scene_closed', 'Messages of a closed scene cannot be changed');
  }
}

const generationHttpError = (err: unknown) => {
  if (!(err instanceof GenerationError)) return err;
  const status = { no_profile: 409, busy: 409, not_found: 404, scene_closed: 409 }[err.code];
  return new HttpError(status, err.code, err.message);
};

export async function chatRoutes(
  app: FastifyInstance,
  { db, hub, generator, worlds, memory, scenes: sceneService }: Services,
) {
  const r = typed(app);
  const changed = (chatId: string) => hub.broadcast({ type: 'chat.changed', chatId });

  const startGeneration = async (chatId: string, parentId: string | null) => {
    try {
      return await generator.start(chatId, parentId);
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
    const character = await worlds.character(body.worldId, body.characterSlug);
    if (!character) throw notFound('Character');
    const greeting = character.summary.greetings[body.greetingIndex] ?? '';

    const timestamp = now();
    const chatId = newId();
    db.insert(chats)
      .values({
        id: chatId,
        title: body.title?.trim() || character.summary.name,
        worldId: body.worldId,
        characterSlug: body.characterSlug,
        activeLeafId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    sceneService.createFirst(chatId, [body.characterSlug], greeting);
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

      const scene = currentScene(db, chat.id);
      if (scene?.status !== 'active') {
        throw new HttpError(409, 'scene_closed', 'Start a new scene to continue');
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
              sceneId: scene.id,
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
      return { messageId: (await startGeneration(chat.id, messageId)).id };
    },
  );

  /** Generates a reply to the active leaf, e.g. after a failed request. */
  r.post('/api/chats/:id/generate', { schema: { params } }, async ({ params }) => {
    const chat = getChatRow(db, params.id);
    if (!chat) throw notFound('Chat');
    return { messageId: (await startGeneration(chat.id, chat.activeLeafId)).id };
  });

  r.post('/api/chats/:id/leaf', { schema: { params, body: selectLeafInput } }, async (req) => {
    const chat = getChatRow(db, req.params.id);
    const target = getMessageRow(db, req.body.messageId);
    if (!chat || target?.chatId !== chat.id) throw notFound('Message');
    assertEditable(db, target);
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
    assertEditable(db, message);
    if (message.parentId === null) {
      throw new HttpError(400, 'invalid_request', 'The start message is edited, not regenerated');
    }
    return { messageId: (await startGeneration(message.chatId, message.parentId)).id };
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
      assertEditable(db, message);
      const row = db
        .update(messages)
        .set({ content: body.content, updatedAt: now(), revision: message.revision + 1 })
        .where(eq(messages.id, message.id))
        .returning()
        .get();
      if (message.sceneId) memory.invalidate(message.chatId, message.sceneId, message.id);
      changed(message.chatId);
      return row ? toMessage(row) : null;
    },
  );

  r.post(
    '/api/chats/:id/scene/close',
    { schema: { params, body: closeSceneInput } },
    async ({ params, body }) => sceneService.close(params.id, body.withCanon),
  );

  r.post(
    '/api/chats/:id/scene/propose',
    { schema: { params, body: sceneProposalInput } },
    async ({ params, body }) => sceneService.propose(params.id, body.brief),
  );

  r.post('/api/chats/:id/scenes', { schema: { params, body: sceneStartInput } }, async (req) => {
    await sceneService.start(req.params.id, req.body);
    return chatPath(db, req.params.id);
  });
}
