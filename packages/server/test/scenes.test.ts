import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanonProposal, ChatPath } from '@teahouse/shared';
import { describe, expect, it } from 'vitest';
import type { StreamFn } from '../src/generation.ts';
import type { ChatMessage } from '../src/llm/client.ts';
import type { CompleteFn } from '../src/memory.ts';
import { parseDocument } from '../src/worlds/frontmatter.ts';
import { createTestApp } from './helpers.ts';

const words = (n: number, word = 'rain') => Array.from({ length: n }, () => word).join(' ');

interface Calls {
  narrator: ChatMessage[][];
  summary: ChatMessage[][];
  canon: ChatMessage[][];
  scene: ChatMessage[][];
}

/** Fake LLM: answers each role with something plausible and records the prompts. */
function fakes(canonReply: () => object = defaultCanon) {
  const calls: Calls = { narrator: [], summary: [], canon: [], scene: [] };
  const stream: StreamFn = async function* (_p, messages) {
    calls.narrator.push(messages);
    yield `Mira answers. ${words(60, 'drizzle')}`;
  };
  const complete: CompleteFn = async (_p, messages) => {
    const system = String(messages[0]?.content);
    if (system.includes('running summary')) {
      calls.summary.push(messages);
      return `Summary ${calls.summary.length}: Mira and Ash met in the tavern.`;
    }
    if (system.includes('canon of a roleplay world')) {
      calls.canon.push(messages);
      return `\`\`\`json\n${JSON.stringify(canonReply())}\n\`\`\``;
    }
    calls.scene.push(messages);
    // The first answer is prose, as some models do; the retry asks again.
    if (calls.scene.length === 1) return 'Sure! Here is an opening: dawn over the harbor.';
    return JSON.stringify({ start_message: 'Dawn over the harbor.', cast: ['mira', 'nobody'] });
  };
  return { calls, stream, complete };
}

function defaultCanon() {
  return {
    event: {
      title: 'The tavern deal',
      summary: 'Ash agreed to smuggle a crate for Mira.',
      body: 'Ash met Mira in the tavern and agreed to move a crate.',
      tags: ['deal'],
    },
    operations: [
      {
        op: 'append_section',
        path: 'characters/mira.md',
        heading: 'Relationships',
        text: 'Owes Ash for the crate.',
      },
      {
        op: 'create',
        path: 'places/tavern.md',
        name: 'The Leaky Cup',
        summary: 'A harbor tavern.',
        tags: ['tavern'],
        body: 'Smoky.',
      },
    ],
  };
}

async function setup(options: { contextWindow?: number; canonReply?: () => object } = {}) {
  const { calls, stream, complete } = fakes(options.canonReply);
  const ctx = await createTestApp(stream, complete);
  await ctx.api('POST', '/api/profiles', {
    name: 'Fake',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'fake',
    temperature: null,
    topP: null,
    maxTokens: 100,
    contextWindowOverride: options.contextWindow ?? 32_000,
  });
  const world = await ctx.worlds.create('Rain Port');
  await ctx.worlds.write(
    world.id,
    'characters/mira.md',
    '---\ntype: character\nname: Mira\ngreetings:\n  - Mira looks up.\n---\n\n# Mira\n\nA smuggler.\n',
  );
  const chat = (
    await ctx.api<ChatPath>('POST', '/api/chats', { worldId: world.id, characterSlug: 'mira' })
  ).body;
  const chatId = chat.chat.id;

  const send = async (content: string) => {
    const before = calls.narrator.length;
    const res = await ctx.api<{ messageId: string }>('POST', `/api/chats/${chatId}/messages`, {
      content,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await waitFor(() => calls.narrator.length > before);
    await waitFor(async () => (await path()).messages.at(-1)?.status === 'complete');
    return res.body.messageId;
  };
  const path = async () => (await ctx.api<ChatPath>('GET', `/api/chats/${chatId}`)).body;
  const proposal = async (sceneId: string) =>
    (await ctx.api<CanonProposal>('GET', `/api/scenes/${sceneId}/proposal`)).body;
  return { ...ctx, calls, world, chatId, send, path, proposal };
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
}

describe('scenes', () => {
  it('starts every chat with scene 1 and its start message', async () => {
    const { path } = await setup();
    const p = await path();
    expect(p.scene).toMatchObject({ number: 1, status: 'active', cast: ['mira'] });
    expect(p.messages.map((m) => m.content)).toEqual(['Mira looks up.']);
    expect(p.scene?.startMessageId).toBe(p.messages[0]?.id);
  });

  it('closes without canon, freezes the scene and starts the next one', async () => {
    const { api, chatId, send, path, calls, worlds, world } = await setup();
    const userMessage = await send('Hello.');
    const closed = await api('POST', `/api/chats/${chatId}/scene/close`, { withCanon: false });
    expect(closed.body).toMatchObject({ status: 'closed' });
    expect((await api('POST', `/api/chats/${chatId}/messages`, { content: 'More' })).status).toBe(
      409,
    );
    expect((await api('PUT', `/api/messages/${userMessage}`, { content: 'Edited' })).status).toBe(
      409,
    );
    expect((await worlds.history(world.id)).length).toBe(2); // no canon commit

    const proposal = await api<{ startMessage: string; cast: string[] }>(
      'POST',
      `/api/chats/${chatId}/scene/propose`,
      { brief: 'Next morning at the docks.' },
    );
    expect(proposal.body).toEqual({ startMessage: 'Dawn over the harbor.', cast: ['mira'] });
    expect(String(calls.scene[0]?.[1]?.content)).toContain('Next morning at the docks.');
    expect(calls.scene).toHaveLength(2);
    expect(String(calls.scene[1]?.at(-1)?.content)).toContain('Return only the JSON object.');

    const next = await api<ChatPath>('POST', `/api/chats/${chatId}/scenes`, proposal.body);
    expect(next.body.scene).toMatchObject({ number: 2, status: 'active' });
    expect(next.body.closedScenes[0]?.messages.map((m) => m.role)).toEqual([
      'assistant',
      'user',
      'assistant',
    ]);
    expect(next.body.messages.map((m) => m.content)).toEqual(['Dawn over the harbor.']);
    expect(next.body.messages[0]?.siblingIds).toHaveLength(1); // scene roots are not siblings

    await send('Good morning.');
    // A new scene sees canon and its start message, not the previous scene's messages.
    const prompt = calls.narrator.at(-1) ?? [];
    expect(prompt.map((m) => m.content)).not.toContain('Hello.');
    expect((await path()).messages).toHaveLength(3);
  });

  it('proposes canon on close and commits accepted files in one commit', async () => {
    const { api, chatId, send, path, proposal, worlds, world, calls } = await setup();
    await send('I take the crate.');
    const sceneId = (await path()).scene?.id ?? '';
    await api('POST', `/api/chats/${chatId}/scene/close`, { withCanon: true });
    await waitFor(async () => (await proposal(sceneId))?.status === 'ready');

    const ready = await proposal(sceneId);
    expect(ready.files.map((f) => f.path)).toEqual([
      'events/mira-scene-1.md',
      'characters/mira.md',
      'places/tavern.md',
    ]);
    const event = parseDocument(ready.files[0]?.after ?? '');
    expect(event.data).toMatchObject({
      type: 'event',
      chat: chatId,
      scene: sceneId,
      order: 1,
      summary: 'Ash agreed to smuggle a crate for Mira.',
    });
    expect((await path()).scene?.status).toBe('closing');

    for (const f of ready.files) {
      const decision = f.path.startsWith('places/') ? 'rejected' : 'accepted';
      await api('PUT', `/api/scenes/${sceneId}/proposal/file`, { path: f.path, decision });
    }
    const applied = await api<{ commit: string }>('POST', `/api/scenes/${sceneId}/proposal/apply`);
    expect(applied.status).toBe(200);

    const [last] = await worlds.history(world.id);
    expect(last?.message).toBe('Canon: Mira, scene 1');
    expect(await worlds.read(world.id, 'characters/mira.md')).toContain(
      '## Relationships\n\nOwes Ash for the crate.',
    );
    expect(await worlds.readIfExists(world.id, 'places/tavern.md')).toBeNull();
    expect((await path()).scene).toMatchObject({
      status: 'closed',
      canonCommit: applied.body.commit,
    });

    // The next scene gets the event through the canon selection.
    await api('POST', `/api/chats/${chatId}/scenes`, { startMessage: 'Later.', cast: ['mira'] });
    await send('Remember the crate?');
    const system = String(calls.narrator.at(-1)?.[0]?.content);
    expect(system).toContain('<file path="events/mira-scene-1.md" name="The tavern deal">');
    expect(system).toContain('Owes Ash for the crate.');
  });

  it('merges proposals with edits made in the meantime and surfaces conflicts', async () => {
    const { api, chatId, send, path, proposal, worlds, world } = await setup();
    await send('Deal.');
    const sceneId = (await path()).scene?.id ?? '';
    await api('POST', `/api/chats/${chatId}/scene/close`, { withCanon: true });
    await waitFor(async () => (await proposal(sceneId))?.status === 'ready');
    for (const f of (await proposal(sceneId)).files) {
      await api('PUT', `/api/scenes/${sceneId}/proposal/file`, {
        path: f.path,
        decision: 'accepted',
      });
    }

    // The user edits the same line the proposal touches: conflict.
    const dir = worlds.dir(world.folder);
    const miraPath = join(dir, 'characters', 'mira.md');
    const mira = await readFile(miraPath, 'utf8');
    await writeFile(
      miraPath,
      mira.replace('A smuggler.', 'A smuggler.\n\n## Relationships\n\nHates Ash.'),
    );
    const conflict = await api('POST', `/api/scenes/${sceneId}/proposal/apply`);
    expect(conflict.status).toBe(409);
    const pending = (await proposal(sceneId)).files.find((f) => f.path === 'characters/mira.md');
    expect(pending).toMatchObject({ decision: 'pending' });
    expect(pending?.after).toContain('<<<<<<< current');

    // Resolve by hand and accept again.
    const resolved = (pending?.after ?? '').replace(
      /<<<<<<< current[\s\S]*>>>>>>> proposal\n/,
      'Hates Ash, owes him anyway.\n',
    );
    await api('PUT', `/api/scenes/${sceneId}/proposal/file`, {
      path: 'characters/mira.md',
      decision: 'accepted',
      after: resolved,
    });
    expect((await api('POST', `/api/scenes/${sceneId}/proposal/apply`)).status).toBe(200);
    expect(await worlds.read(world.id, 'characters/mira.md')).toContain(
      'Hates Ash, owes him anyway.',
    );
  });

  it('applies canon without review when review is off, and retries invalid JSON once', async () => {
    let attempt = 0;
    const { api, chatId, send, path, calls, worlds, world } = await setup({
      canonReply: () => (++attempt === 1 ? { nonsense: true } : defaultCanon()),
    });
    const settings = await api<Record<string, unknown>>('GET', '/api/settings');
    await api('PUT', '/api/settings', { ...settings.body, canonReview: false });
    await send('Deal.');
    await api('POST', `/api/chats/${chatId}/scene/close`, { withCanon: true });
    await waitFor(async () => (await path()).scene?.status === 'closed');
    expect(calls.canon).toHaveLength(2); // the invalid answer, then the retry
    expect(attempt).toBe(2);
    expect((await worlds.history(world.id))[0]?.message).toBe('Canon: Mira, scene 1');
    expect(await worlds.readIfExists(world.id, 'places/tavern.md')).not.toBeNull();
  });
});

describe('Active Memory', () => {
  it('summarizes in the background, keeps the last turns verbatim and invalidates on edit', async () => {
    const { send, path, calls, api } = await setup({ contextWindow: 1400 });
    const ids: string[] = [];
    for (let i = 1; i <= 8; i++) ids.push(await send(`Turn ${i}. ${words(40)}`));
    await waitFor(async () => (await path()).memory.length > 0);

    const memory = (await path()).memory;
    expect(calls.summary.length).toBeGreaterThan(0);
    // The summary call got the previous summary and only the section that falls out.
    const first = String(calls.summary[0]?.[1]?.content);
    expect(first).toContain('(nothing yet)');
    expect(first).toContain('Turn 1.');
    expect(first).not.toContain('Turn 8.');

    await send(`Turn 9. ${words(5)}`);
    const prompt = (calls.narrator.at(-1) ?? []).map((m) => String(m.content));
    expect(prompt[0]).toContain(`<scene_so_far>\n${memory.at(-1)?.content}`);
    expect(prompt[1]).toBe('Mira looks up.'); // start message stays verbatim
    expect(prompt.some((c) => c.startsWith('Turn 1.'))).toBe(false);
    for (const n of [7, 8, 9]) expect(prompt.some((c) => c.startsWith(`Turn ${n}.`))).toBe(true);

    // Editing a message the summary covers drops that summary.
    const covered = memory[0]?.messageId ?? '';
    const coveredIndex = ids.indexOf(covered);
    const target = coveredIndex >= 0 ? covered : (ids[0] ?? '');
    await api('PUT', `/api/messages/${target}`, { content: 'Turn 1, rewritten.' });
    const after = (await path()).memory.map((m) => m.id);
    expect(after).not.toContain(memory[0]?.id);
  });
});
