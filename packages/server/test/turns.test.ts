import { type ChatPath, NARRATOR_SPEAKER } from '@teahouse/shared';
import { describe, expect, it } from 'vitest';
import type { StreamFn } from '../src/generation.ts';
import type { ChatMessage } from '../src/llm/client.ts';
import { createTestApp, profileBody } from './helpers.ts';

/** A world with Mira and Tomas; the chat starts with Mira. Replies come from `replies`. */
async function setup(replies: string[][]) {
  const prompts: ChatMessage[][] = [];
  const stream: StreamFn = async function* (_p, messages) {
    prompts.push(messages);
    yield* replies[prompts.length - 1] ?? ['<narration>…</narration>'];
  };
  const ctx = await createTestApp(stream);
  await ctx.api('POST', '/api/profiles', {
    ...profileBody('http://127.0.0.1:9/v1'),
    contextWindowOverride: 32000,
  });
  const world = await ctx.worlds.create('Rain Port');
  await ctx.worlds.write(
    world.id,
    'characters/mira.md',
    '---\ntype: character\nname: Mira\ngreetings:\n  - <narration>Mira looks up.</narration>\n---\n\nA smuggler.',
  );
  await ctx.worlds.write(
    world.id,
    'characters/tomas.md',
    '---\ntype: character\nname: Tomas\n---\n\nThe innkeeper.',
  );
  const chat = await ctx.api<ChatPath>('POST', '/api/chats', {
    worldId: world.id,
    characterSlug: 'mira',
  });
  const id = chat.body.chat.id;
  const path = async () => (await ctx.api<ChatPath>('GET', `/api/chats/${id}`)).body;
  const settled = () => waitFor(async () => (await path()).messages.at(-1)?.status !== 'streaming');
  const system = (n: number) => String(prompts[n]?.[0]?.content);
  return { ...ctx, id, path, settled, prompts, system };
}

describe('one character per turn', () => {
  it('plays the character the user picked and stores them as the speaker', async () => {
    const { api, id, path, settled, system } = await setup([['<say who="tomas">Rooms?</say>']]);
    await api('POST', `/api/chats/${id}/messages`, { content: 'Hello.', speaker: 'tomas' });
    await settled();

    expect(system(0)).toContain("<turn>\nThis turn is Tomas's.");
    expect(system(0)).toContain('use <say> only with who="tomas"');
    // Tomas joins the core canon although he is not in the cast.
    expect(system(0)).toContain('The innkeeper.');
    const reply = (await path()).messages.at(-1);
    expect(reply).toMatchObject({ speaker: 'tomas', content: '<say who="tomas">Rooms?</say>' });
  });

  it('defaults to whoever had the last turn, then to the first of the cast', async () => {
    const { api, id, path, settled, system } = await setup([]);
    await api('POST', `/api/chats/${id}/messages`, { content: 'Hi.' });
    await settled();
    expect(system(0)).toContain("This turn is Mira's.");
    await api('POST', `/api/chats/${id}/generate`, { speaker: 'tomas' });
    await settled();
    await api('POST', `/api/chats/${id}/messages`, { content: 'And?' });
    await settled();
    expect(system(2)).toContain("This turn is Tomas's.");
    expect((await path()).messages.map((m) => m.speaker)).toEqual([
      null,
      null,
      'mira',
      'tomas',
      null,
      'tomas',
    ]);
  });

  it('brings the speaker on stage', async () => {
    const { api, id, settled, system } = await setup([['<narration>Tomas nods.</narration>']]);
    await api('POST', `/api/chats/${id}/generate`, { speaker: 'tomas' });
    await settled();
    await api('POST', `/api/chats/${id}/messages`, { content: 'Hi.' });
    await settled();
    expect(system(1)).toContain('Present: mira, tomas.');
  });

  it('cuts the reply where the character starts speaking for someone else', async () => {
    const { api, id, path, settled } = await setup([
      [
        '<say who="Mira">Well?</say>',
        '<narration>Tomas sighs.</narration><say who="tomas">Fine.</say>',
      ],
    ]);
    await api('POST', `/api/chats/${id}/messages`, { content: 'So?' });
    await settled();
    expect((await path()).messages.at(-1)).toMatchObject({
      status: 'complete',
      content: '<say who="Mira">Well?</say><narration>Tomas sighs.</narration>',
    });
  });

  it('lets the narrator describe, but not speak for anyone', async () => {
    const { api, id, path, settled, system } = await setup([
      ['<narration>Thunder.</narration>', '<say who="mira">Oh.</say>'],
    ]);
    await api('POST', `/api/chats/${id}/generate`, { speaker: NARRATOR_SPEAKER });
    await settled();
    expect(system(0)).toContain("This turn is the narrator's.");
    expect((await path()).messages.at(-1)).toMatchObject({
      speaker: NARRATOR_SPEAKER,
      content: '<narration>Thunder.</narration>',
    });
  });

  it('regenerates with the same speaker', async () => {
    const { api, id, path, settled, system } = await setup([]);
    await api('POST', `/api/chats/${id}/messages`, { content: 'Hi.', speaker: 'tomas' });
    await settled();
    const reply = (await path()).messages.at(-1);
    await api('POST', `/api/messages/${reply?.id}/regenerate`);
    await settled();
    expect(system(1)).toContain("This turn is Tomas's.");
    expect((await path()).messages.at(-1)?.speaker).toBe('tomas');
  });

  it('joins turns in a row, so roles still alternate', async () => {
    const { api, id, settled, prompts } = await setup([]);
    await api('POST', `/api/chats/${id}/generate`, { speaker: 'tomas' });
    await settled();
    await api('POST', `/api/chats/${id}/generate`, { speaker: 'mira' });
    await settled();
    // System, then the greeting and Tomas's turn as one assistant message.
    expect(prompts[1]?.map((m) => m.role)).toEqual(['system', 'assistant']);
    expect(prompts[1]?.[1]?.content).toBe(
      '<narration>Mira looks up.</narration>\n\n<narration>…</narration>',
    );
  });

  it('refuses a speaker who is not in the world', async () => {
    const { api, id } = await setup([]);
    const res = await api('POST', `/api/chats/${id}/generate`, { speaker: 'nobody' });
    expect(res.status).toBe(404);
  });
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}
