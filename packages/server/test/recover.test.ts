import type { CanonProposal, ChatPath } from '@teahouse/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { canonProposals, messages, scenes } from '../src/db/schema.ts';
import type { StreamFn } from '../src/generation.ts';
import type { CompleteFn } from '../src/memory.ts';
import { INTERRUPTED } from '../src/recover.ts';
import { createTestApp } from './helpers.ts';

const stream: StreamFn = async function* () {
  yield 'Mira nods.';
};

/** A canon call that never answers, like an endpoint that hangs; it only ends when aborted. */
function hangingComplete() {
  const calls: AbortSignal[] = [];
  const complete: CompleteFn = (_p, _m, options = {}) => {
    const signal = options.signal as AbortSignal;
    calls.push(signal);
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  return { calls, complete };
}

async function setup(complete?: CompleteFn) {
  const ctx = await createTestApp(stream, complete);
  await ctx.api('POST', '/api/profiles', {
    name: 'Fake',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'fake',
    temperature: null,
    topP: null,
    maxTokens: 100,
    contextWindowOverride: 32_000,
  });
  const world = await ctx.worlds.create('Rain Port');
  await ctx.worlds.write(
    world.id,
    'characters/mira.md',
    '---\ntype: character\nname: Mira\ngreetings:\n  - Mira looks up.\n---\n\n# Mira\n',
  );
  const chat = (
    await ctx.api<ChatPath>('POST', '/api/chats', { worldId: world.id, characterSlug: 'mira' })
  ).body;
  const proposal = async (sceneId: string) =>
    (await ctx.api<CanonProposal>('GET', `/api/scenes/${sceneId}/proposal`)).body;
  return { ...ctx, chat, proposal };
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}

describe('recovery after a crash', () => {
  it('settles replies left streaming and proposals left generating when it boots', async () => {
    const { db, worlds, chat } = await setup();
    const scene = chat.scene;
    if (!scene) throw new Error('no scene');
    const timestamp = new Date().toISOString();
    // What a crash in the middle of a reply and a canon proposal leaves behind.
    db.insert(messages)
      .values({
        id: 'reply-cut-off',
        chatId: chat.chat.id,
        sceneId: scene.id,
        parentId: chat.messages[0]?.id ?? null,
        role: 'assistant',
        content: 'Mira start',
        status: 'streaming',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    db.update(scenes).set({ status: 'closing' }).where(eq(scenes.id, scene.id)).run();
    db.insert(canonProposals)
      .values({
        id: 'proposal-cut-off',
        sceneId: scene.id,
        status: 'generating',
        files: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();

    const restarted = await buildApp({ db, worlds });
    await restarted.close();

    const reply = db.select().from(messages).where(eq(messages.id, 'reply-cut-off')).get();
    expect(reply).toMatchObject({ status: 'stopped', content: 'Mira start', revision: 2 });
    const proposal = db
      .select()
      .from(canonProposals)
      .where(eq(canonProposals.id, 'proposal-cut-off'))
      .get();
    expect(proposal).toMatchObject({ status: 'failed', error: INTERRUPTED, revision: 2 });
  });

  it('leaves finished replies and proposals alone', async () => {
    const { db, worlds, chat } = await setup();
    const before = db.select().from(messages).all();
    const restarted = await buildApp({ db, worlds });
    await restarted.close();
    expect(db.select().from(messages).all()).toEqual(before);
    expect(before.map((m) => m.id)).toEqual(chat.messages.map((m) => m.id));
  });

  it('proposes again while a proposal hangs, and stops a hung one on shutdown', async () => {
    const { calls, complete } = hangingComplete();
    const { app, api, db, chat, proposal } = await setup(complete);
    const sceneId = chat.scene?.id ?? '';
    await api('POST', `/api/chats/${chat.chat.id}/scene/close`, { withCanon: true });
    await waitFor(() => calls.length === 1);
    expect((await proposal(sceneId)).status).toBe('generating');

    // Regenerate abandons the hung call for a new one, which hangs as well.
    const again = await api<CanonProposal>('POST', `/api/scenes/${sceneId}/proposal/regenerate`);
    expect(again.status).toBe(200);
    await waitFor(() => calls.length === 2);
    expect(calls[0]?.aborted).toBe(true);
    expect((await proposal(sceneId)).status).toBe('generating');

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls[1]?.aborted).toBe(true);
    const rows = db.select().from(canonProposals).where(eq(canonProposals.sceneId, sceneId)).all();
    expect(rows).toMatchObject([{ status: 'failed', error: INTERRUPTED }]);
  });
});
