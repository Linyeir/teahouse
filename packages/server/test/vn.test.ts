import type { CharacterSummary, ChatPath, WorldBackground } from '@teahouse/shared';
import { describe, expect, it } from 'vitest';
import type { StreamFn } from '../src/generation.ts';
import type { ChatMessage } from '../src/llm/client.ts';
import { createTestApp, profileBody } from './helpers.ts';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function setup(reply: string[]) {
  const prompts: ChatMessage[][] = [];
  const stream: StreamFn = async function* (_p, messages) {
    prompts.push(messages);
    yield* reply;
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
    '---\ntype: character\nname: Mira\ngreetings:\n  - <narration>Mira looks up.</narration>\n---\n\n# Mira\n',
  );
  const upload = async (url: string, fields: Record<string, string>, name = 'x.png') => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', new Blob([PIXEL], { type: 'image/png' }), name);
    const res = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${ctx.token}` },
      body: form,
    });
    return { status: res.statusCode, body: res.json() };
  };
  return { ...ctx, world, prompts, upload };
}

describe('character images and backgrounds', () => {
  it('uploads, replaces by label, lists and deletes images', async () => {
    const { api, world, upload, worlds } = await setup([]);
    const base = `/api/worlds/${world.id}`;
    const first = await upload(`${base}/characters/mira/images`, { label: 'Amused' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      label: 'amused',
      file: expect.stringMatching(/^assets\/characters\/mira\/.+\.png$/),
    });
    const again = await upload(`${base}/characters/mira/images`, { label: 'amused' });
    await upload(`${base}/characters/mira/images`, { label: 'angry' });

    const characters = await api<CharacterSummary[]>('GET', `${base}/characters`);
    expect(characters.body[0]?.images.map((i) => i.label)).toEqual(['amused', 'angry']);
    expect(characters.body[0]?.images[0]?.id).toBe(again.body.id);

    const removed = await api('DELETE', `${base}/characters/mira/images/${again.body.id}`);
    expect(removed.status).toBe(200);
    expect(
      (await api<CharacterSummary[]>('GET', `${base}/characters`)).body[0]?.images.map(
        (i) => i.label,
      ),
    ).toEqual(['angry']);
    expect((await worlds.history(world.id))[0]?.message).toBe('Remove an image of mira');

    expect((await upload(`${base}/characters/nobody/images`, { label: 'x' })).status).toBe(404);
    expect((await upload(`${base}/characters/mira/images`, { label: '' })).status).toBe(400);
  });

  it('rejects files that are not images', async () => {
    const { world, app, token } = await setup([]);
    const form = new FormData();
    form.append('label', 'neutral');
    form.append('file', new Blob(['#!/bin/sh'], { type: 'text/plain' }), 'evil.sh');
    const res = await app.inject({
      method: 'POST',
      url: `/api/worlds/${world.id}/characters/mira/images`,
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    expect(res.statusCode).toBe(400);
  });

  it('stores backgrounds in world.md', async () => {
    const { api, world, upload, worlds } = await setup([]);
    const base = `/api/worlds/${world.id}`;
    const bg = await upload(`${base}/backgrounds`, {
      id: 'Tavern Night',
      description: 'The Leaky Cup after dark',
    });
    expect(bg.body).toMatchObject({ id: 'tavern-night', description: 'The Leaky Cup after dark' });
    expect((await api<WorldBackground[]>('GET', `${base}/backgrounds`)).body).toHaveLength(1);
    expect(await worlds.read(world.id, 'world.md')).toContain('backgrounds:');
    await api('DELETE', `${base}/backgrounds/tavern-night`);
    expect((await api<WorldBackground[]>('GET', `${base}/backgrounds`)).body).toEqual([]);
  });
});

describe('markup in the narrator turn', () => {
  it('tells the narrator the tags, the characters with moods, the backgrounds and the stage', async () => {
    const { api, world, upload, prompts } = await setup([
      '<say who="mira" mood="amused">Hi.</say>',
    ]);
    await upload(`/api/worlds/${world.id}/characters/mira/images`, { label: 'amused' });
    await upload(`/api/worlds/${world.id}/backgrounds`, {
      id: 'tavern',
      description: 'A smoky tavern',
    });
    const chat = await api<ChatPath>('POST', '/api/chats', {
      worldId: world.id,
      characterSlug: 'mira',
    });
    await api('POST', `/api/chats/${chat.body.chat.id}/messages`, { content: '*I sit.* Hello.' });
    await waitFor(() => prompts.length > 0);
    const system = String(prompts[0]?.[0]?.content);
    expect(system).toContain('<say who="slug" mood="label">');
    expect(system).toContain('- mira: Mira (moods: amused)');
    expect(system).toContain('- tavern: A smoky tavern');
    expect(system).toContain('Present: mira.');
  });

  it('cuts the reply where the model starts speaking for the user', async () => {
    const { api, world } = await setup([
      '<narration>Mira grins.</narration>',
      '<say who="mira">Well?</say><sa',
      'y who="User">Fine, I accept.</say>',
      '<narration>Never sent.</narration>',
    ]);
    const chat = await api<ChatPath>('POST', '/api/chats', {
      worldId: world.id,
      characterSlug: 'mira',
    });
    const id = chat.body.chat.id;
    await api('POST', `/api/chats/${id}/messages`, { content: 'So?' });
    await waitFor(
      async () =>
        (await api<ChatPath>('GET', `/api/chats/${id}`)).body.messages.at(-1)?.status ===
        'complete',
    );
    const last = (await api<ChatPath>('GET', `/api/chats/${id}`)).body.messages.at(-1);
    expect(last?.content).toBe('<narration>Mira grins.</narration><say who="mira">Well?</say>');
  });
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}
