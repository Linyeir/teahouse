import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanonProposal, ChatPath } from '@teahouse/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { applyOps } from '../src/canon/ops.ts';
import { messages, scenes } from '../src/db/schema.ts';
import type { ChatMessage } from '../src/llm/client.ts';
import type { CompleteFn } from '../src/memory.ts';
import { parseDocument } from '../src/worlds/frontmatter.ts';
import { createTestApp } from './helpers.ts';

const MIRA = `---
type: character
name: Mira
aliases: []
tags: [smuggler]
summary: A smuggler.
greetings:
  - Mira looks up.
---

# Mira

A smuggler in the harbor. She has never set foot in the lighthouse.
`;

const FOX = `---
type: character
name: The Fox
aliases: [Fox]
tags: [thief]
summary: A thief.
greetings:
  - The Fox grins.
---

# The Fox

Picks locks for Mira's crew.
`;

const LIGHTHOUSE = `---
type: place
name: Lighthouse
summary: Old lighthouse.
---

# Lighthouse

## Keepers

Mira has kept the lamp here for years.
`;

const cleanupReply = () => ({
  operations: [
    { op: 'merge', path: 'characters/mira.md', from: 'characters/fox.md' },
    {
      op: 'fix_contradiction',
      path: 'places/lighthouse.md',
      heading: 'Keepers',
      text: 'Nobody has kept the lamp for years.',
      other: 'characters/mira.md',
      other_quote: 'She has never set foot in the lighthouse.',
    },
    { op: 'set_summary', path: 'places/lighthouse.md', text: 'A dark, abandoned lighthouse.' },
    { op: 'append_section', path: 'events/x.md', heading: 'No', text: 'Never touched.' },
  ],
});

async function setup() {
  const prompts: ChatMessage[][] = [];
  const complete: CompleteFn = async (_p, messages) => {
    prompts.push(messages);
    return JSON.stringify(cleanupReply());
  };
  const ctx = await createTestApp(undefined, complete);
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
  await ctx.worlds.write(world.id, 'characters/mira.md', MIRA);
  await ctx.worlds.write(world.id, 'characters/fox.md', FOX);
  await ctx.worlds.write(world.id, 'places/lighthouse.md', LIGHTHOUSE);
  const chat = (
    await ctx.api<ChatPath>('POST', '/api/chats', { worldId: world.id, characterSlug: 'fox' })
  ).body;
  const cleanup = async () =>
    (await ctx.api<CanonProposal | null>('GET', `/api/worlds/${world.id}/cleanup`)).body;
  const ready = async () => {
    for (let i = 0; i < 300; i++) {
      const p = await cleanup();
      if (p && p.status !== 'generating') return p;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Timed out');
  };
  return { ...ctx, prompts, world, chat, cleanup, ready };
}

describe('canon cleanup', () => {
  it('proposes merges, contradiction fixes and summaries for review, never touching events', async () => {
    const { api, world, ready, prompts, chat, db } = await setup();
    // Review off applies scene proposals right away; a cleanup still waits.
    const settings = await api<object>('GET', '/api/settings');
    await api('PUT', '/api/settings', { ...settings.body, canonReview: false });

    expect((await api('POST', `/api/worlds/${world.id}/cleanup`)).status).toBe(200);
    const proposal = await ready();
    expect(proposal).toMatchObject({ kind: 'cleanup', worldId: world.id, sceneId: null });
    expect(proposal.status).toBe('ready');
    expect(String(prompts[0]?.[1]?.content)).toContain('<file path="characters/fox.md">');

    const byPath = Object.fromEntries(proposal.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual([
      'characters/fox.md',
      'characters/mira.md',
      'places/lighthouse.md',
    ]);
    expect(byPath['characters/fox.md']).toMatchObject({
      after: null,
      changes: [{ op: 'merged_into', detail: 'characters/mira.md' }],
    });
    expect(byPath['characters/mira.md']?.changes).toEqual([
      { op: 'merge', detail: 'characters/fox.md' },
    ]);
    expect(byPath['places/lighthouse.md']?.changes).toContainEqual({
      op: 'fix_contradiction',
      detail: 'Keepers',
      contradicts: {
        path: 'characters/mira.md',
        quote: 'She has never set foot in the lighthouse.',
      },
    });
    // The scene the chat is in stays as it was.
    const scene = db.select().from(scenes).where(eq(scenes.chatId, chat.chat.id)).get();
    expect(scene?.status).toBe('active');
  });

  it('applies accepted files in one commit and moves the chats of a merged character', async () => {
    const { api, world, worlds, ready, chat, db } = await setup();
    const sceneId = chat.scene?.id as string;
    db.insert(messages)
      .values({
        id: 'reply-fox',
        chatId: chat.chat.id,
        sceneId,
        parentId: chat.messages[0]?.id ?? null,
        role: 'assistant',
        content: '<say who="fox">Evening.</say>',
        speaker: 'fox',
        status: 'complete',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      })
      .run();
    await api('POST', `/api/worlds/${world.id}/cleanup`);
    const proposal = await ready();
    const before = (await worlds.history(world.id)).length;

    // The merged file goes only with the file that takes it in.
    await api('PUT', `/api/worlds/${world.id}/cleanup/file`, {
      path: 'characters/fox.md',
      decision: 'accepted',
    });
    await api('PUT', `/api/worlds/${world.id}/cleanup/file`, {
      path: 'characters/mira.md',
      decision: 'rejected',
    });
    expect((await api('POST', `/api/worlds/${world.id}/cleanup/apply`)).status).toBe(409);

    for (const file of proposal.files) {
      await api('PUT', `/api/worlds/${world.id}/cleanup/file`, {
        path: file.path,
        decision: 'accepted',
      });
    }
    const applied = await api<{ commit: string }>('POST', `/api/worlds/${world.id}/cleanup/apply`);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect((await worlds.history(world.id)).length).toBe(before + 1);

    const dir = worlds.dir((await worlds.get(world.id)).folder);
    await expect(readFile(join(dir, 'characters/fox.md'), 'utf8')).rejects.toThrow();
    const mira = parseDocument(await readFile(join(dir, 'characters/mira.md'), 'utf8'));
    expect(mira.data.aliases).toEqual(['The Fox', 'Fox']);
    expect(mira.data.tags).toEqual(['smuggler', 'thief']);
    expect(mira.data.greetings).toEqual(['Mira looks up.', 'The Fox grins.']);
    expect(mira.body).toContain("## The Fox\n\nPicks locks for Mira's crew.");
    const lighthouse = await readFile(join(dir, 'places/lighthouse.md'), 'utf8');
    expect(lighthouse).toContain('Nobody has kept the lamp for years.');
    expect(lighthouse).not.toContain('Mira has kept the lamp');

    const path = (await api<ChatPath>('GET', `/api/chats/${chat.chat.id}`)).body;
    expect(path.chat.characterSlug).toBe('mira');
    expect(path.scene?.cast).toEqual(['mira']);
    const reply = db.select().from(messages).where(eq(messages.id, 'reply-fox')).get();
    expect(reply).toMatchObject({ speaker: 'mira', content: '<say who="mira">Evening.</say>' });
    expect((await api<CanonProposal>('GET', `/api/worlds/${world.id}/cleanup`)).body.status).toBe(
      'applied',
    );
  });

  it('keeps a merged file that changed since the proposal', async () => {
    const { api, world, worlds, ready } = await setup();
    await api('POST', `/api/worlds/${world.id}/cleanup`);
    const proposal = await ready();
    for (const file of proposal.files) {
      await api('PUT', `/api/worlds/${world.id}/cleanup/file`, {
        path: file.path,
        decision: 'accepted',
      });
    }
    await worlds.write(world.id, 'characters/fox.md', `${FOX}\nNew line.\n`);
    const res = await api('POST', `/api/worlds/${world.id}/cleanup/apply`);
    expect(res.status).toBe(409);
    expect(await worlds.readIfExists(world.id, 'characters/fox.md')).toContain('New line.');
  });
});

describe('applyOps merge', () => {
  it('refuses merges across folders, into itself and of events', () => {
    const current = new Map([
      ['characters/mira.md', MIRA],
      ['places/lighthouse.md', LIGHTHOUSE],
      ['events/a.md', '---\ntype: event\nname: A\n---\n\nA.\n'],
    ]);
    const { files, notes } = applyOps(current, [
      { op: 'merge', path: 'characters/mira.md', from: 'places/lighthouse.md' },
      { op: 'merge', path: 'characters/mira.md', from: 'characters/mira.md' },
      { op: 'merge', path: 'characters/mira.md', from: 'events/a.md' },
    ]);
    expect(files.size).toBe(0);
    expect(notes.map((n) => n.code)).toEqual([
      'merge_not_allowed',
      'merge_not_allowed',
      'merge_not_allowed',
    ]);
  });
});
