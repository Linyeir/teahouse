import type { ChatPath } from '@teahouse/shared';
import { describe, expect, it, vi } from 'vitest';
import { chats, messages, scenes } from '../src/db/schema.ts';
import { newId } from '../src/time.ts';
import { createTestApp } from './helpers.ts';

/** A chat of `sceneCount` closed scenes and an active one, `perScene` messages each. */
async function longChat(sceneCount: number, perScene: number) {
  const ctx = await createTestApp();
  const world = await ctx.worlds.create('W');
  const chatId = newId();
  const t = new Date().toISOString();
  const row = { createdAt: t, updatedAt: t };
  ctx.db.transaction((tx) => {
    tx.insert(chats)
      .values({ id: chatId, title: 'Long', worldId: world.id, characterSlug: 'mira', ...row })
      .run();
    let leaf: string | null = null;
    for (let n = 1; n <= sceneCount + 1; n++) {
      const sceneId = newId();
      let parentId: string | null = null;
      let first: string | null = null;
      for (let i = 0; i < perScene; i++) {
        const id = newId();
        first ??= id;
        tx.insert(messages)
          .values({
            id,
            chatId,
            sceneId,
            parentId,
            role: i % 2 ? 'user' : 'assistant',
            content: `<narration>Message ${i} of scene ${n}, with some words to it.</narration>`,
            status: 'complete',
            ...row,
          })
          .run();
        parentId = id;
      }
      leaf = parentId;
      const active = n === sceneCount + 1;
      tx.insert(scenes)
        .values({
          id: sceneId,
          chatId,
          number: n,
          status: active ? 'active' : 'closed',
          cast: ['mira'],
          startMessageId: first,
          closedLeafId: active ? null : leaf,
          ...row,
        })
        .run();
    }
    tx.update(chats).set({ activeLeafId: leaf }).run();
  });
  return { ...ctx, chatId };
}

describe('the chat payload', () => {
  it('reads the messages once, however many scenes the chat has', async () => {
    const counts: number[] = [];
    for (const sceneCount of [2, 20]) {
      const { api, db, chatId } = await longChat(sceneCount, 4);
      const select = vi.spyOn(db, 'select');
      const res = await api<ChatPath>('GET', `/api/chats/${chatId}`);
      expect(res.body.closedScenes).toHaveLength(sceneCount);
      counts.push(select.mock.calls.length);
      select.mockRestore();
    }
    // The same queries for 2 and for 20 scenes; loading the tree per scene added one each.
    expect(counts[1]).toBe(counts[0]);
  });

  it('comes back quickly for 40 scenes of 60 messages', async () => {
    const { api, chatId } = await longChat(40, 60);
    await api('GET', `/api/chats/${chatId}`); // warm up
    const started = performance.now();
    const res = await api<ChatPath>('GET', `/api/chats/${chatId}`);
    const ms = performance.now() - started;
    expect(res.body.closedScenes).toHaveLength(40);
    expect(res.body.messages).toHaveLength(60);
    // 621 ms before the tree was loaded once; the bound leaves room for slow CI runners.
    expect(ms).toBeLessThan(250);
  });
});
