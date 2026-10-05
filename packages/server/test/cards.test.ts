import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encode as encodeText } from 'png-chunk-text';
import encodeChunks from 'png-chunks-encode';
import extractChunks from 'png-chunks-extract';
import { describe, expect, it } from 'vitest';
import { importCard } from '../src/cards/import.ts';
import { CardError, parseCard } from '../src/cards/parse.ts';
import { parseDocument } from '../src/worlds/frontmatter.ts';
import { createTestApp, tempWorlds } from './helpers.ts';

// 1×1 transparent PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function pngCard(chunks: Record<string, unknown>): Buffer {
  const parts = extractChunks(PIXEL);
  const end = parts.pop();
  for (const [keyword, json] of Object.entries(chunks)) {
    parts.push(encodeText(keyword, Buffer.from(JSON.stringify(json)).toString('base64')));
  }
  if (end) parts.push(end);
  return Buffer.from(encodeChunks(parts));
}

const v2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Mira Vale',
    description: '{{char}} is a smuggler in Rain Port. She owes <USER> a favor.',
    personality: 'Wry, guarded, loyal.',
    scenario: 'A tavern by the harbor, late at night.',
    first_mes: '*Mira looks up.* "You again."',
    alternate_greetings: ['"Took you long enough."'],
    mes_example: '<START>\n{{char}}: "Sit."',
    creator_notes: 'Works best with slow pacing.',
    system_prompt: '',
    post_history_instructions: '',
    tags: ['smuggler', 'fantasy'],
    creator: 'someone',
    character_version: '1',
    extensions: {},
    character_book: {
      entries: [
        {
          keys: ['Rain Port', 'port'],
          content: 'A harbor city where it always rains.',
          comment: 'Rain Port',
          enabled: true,
          insertion_order: 0,
          extensions: {},
        },
        {
          keys: ['Guild'],
          content: 'The smugglers guild.',
          enabled: false,
          insertion_order: 1,
          extensions: {},
        },
        { keys: ['empty'], content: '  ', enabled: true, insertion_order: 2, extensions: {} },
      ],
    },
  },
};

describe('parseCard', () => {
  it('reads V2 from a PNG and prefers the V3 chunk when both exist', () => {
    expect(parseCard(pngCard({ chara: v2 })).spec).toBe('v2');
    const v3 = { ...v2, spec: 'chara_card_v3', data: { ...v2.data, name: 'Mira V3' } };
    const card = parseCard(pngCard({ chara: v2, ccv3: v3 }));
    expect(card.spec).toBe('v3');
    expect(card.data.name).toBe('Mira V3');
  });

  it('reads JSON cards including V1 and converts old macros', () => {
    const card = parseCard(
      Buffer.from(JSON.stringify({ name: 'Old', description: '<BOT> likes <user>' })),
    );
    expect(card.spec).toBe('v1');
    expect(card.data.description).toBe('{{char}} likes {{user}}');
  });

  it('rejects files without card data', () => {
    expect(() => parseCard(PIXEL)).toThrow(CardError);
    expect(() => parseCard(Buffer.from('not json'))).toThrow(CardError);
    expect(() => parseCard(Buffer.from('{"description":"no name"}'))).toThrow(CardError);
  });
});

describe('importCard', () => {
  it('creates a world with character, lore and image in one commit', async () => {
    const worlds = await tempWorlds();
    const result = await importCard(worlds, pngCard({ chara: v2 }), {});
    expect(result.characterSlug).toBe('mira-vale');
    expect(result.files).toEqual([
      'world.md',
      'characters/mira-vale.md',
      'lore/rain-port.md',
      'lore/guild.md',
    ]);

    const world = await worlds.get(result.worldId);
    expect(world.name).toBe('Mira Vale');
    expect(await worlds.read(world.id, 'world.md')).toContain(
      '## Scenario\n\nA tavern by the harbor',
    );

    const character = parseDocument(await worlds.read(world.id, 'characters/mira-vale.md'));
    expect(character.data).toMatchObject({
      type: 'character',
      name: 'Mira Vale',
      tags: ['smuggler', 'fantasy'],
      summary: '{{char}} is a smuggler in Rain Port.',
      greetings: ['*Mira looks up.* "You again."', '"Took you long enough."'],
      creator_notes: 'Works best with slow pacing.',
    });
    expect(character.body).toContain('She owes {{user}} a favor.');
    expect(character.body).toContain('## Personality\n\nWry, guarded, loyal.');
    expect(character.body).toContain('## Example dialogue');
    expect(character.body).not.toContain('## Scenario');

    const images = character.data.images as { file: string }[];
    expect(images).toHaveLength(1);
    const image = await readFile(join(worlds.dir(world.folder), images[0]?.file ?? ''));
    expect(image.subarray(0, 4).toString('latin1')).toBe('\x89PNG');

    const lore = parseDocument(await worlds.read(world.id, 'lore/rain-port.md'));
    expect(lore.data).toMatchObject({ type: 'lore', tags: ['Rain Port', 'port'] });
    expect(parseDocument(await worlds.read(world.id, 'lore/guild.md')).data.enabled).toBe(false);

    expect((await worlds.history(world.id)).map((c) => c.message)).toEqual([
      'Import character card: Mira Vale',
      'Create world Mira Vale',
    ]);
  });

  it('puts the scenario into the character file when importing into an existing world', async () => {
    const worlds = await tempWorlds();
    const world = await worlds.create('Existing');
    await importCard(worlds, Buffer.from(JSON.stringify(v2)), { worldId: world.id });
    const second = await importCard(worlds, Buffer.from(JSON.stringify(v2)), { worldId: world.id });
    expect(second.characterSlug).toBe('mira-vale-2');
    const text = await worlds.read(world.id, 'characters/mira-vale.md');
    expect(text).toContain('## Scenario');
    expect(await worlds.read(world.id, 'world.md')).not.toContain('Scenario');
  });

  it('imports over HTTP and starts a chat with the first greeting', async () => {
    const { app, token, api } = await createTestApp();
    const form = new FormData();
    form.append('file', new Blob([pngCard({ chara: v2 })]), 'mira.png');
    form.append('newWorldName', 'Rain Port');
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/card',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    expect(res.statusCode).toBe(200);
    const { worldId, characterSlug } = res.json();

    const characters = await api<{ name: string; images: { file: string }[] }[]>(
      'GET',
      `/api/worlds/${worldId}/characters`,
    );
    expect(characters.body[0]?.name).toBe('Mira Vale');
    const asset = characters.body[0]?.images[0]?.file.replace(/^assets\//, '');
    const image = await app.inject({
      url: `/api/worlds/${worldId}/assets/${asset}?token=${token}`,
    });
    expect(image.headers['content-type']).toBe('image/png');

    const chat = await api<{ messages: { content: string }[] }>('POST', '/api/chats', {
      worldId,
      characterSlug,
      greetingIndex: 1,
    });
    expect(chat.body.messages[0]?.content).toBe('"Took you long enough."');
  });
});
