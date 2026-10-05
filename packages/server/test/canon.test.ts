import { describe, expect, it } from 'vitest';
import { mergeThreeWay } from '../src/canon/merge.ts';
import { applyOps, upsertSection } from '../src/canon/ops.ts';
import { mentions, selectCanon } from '../src/context/canon.ts';
import { countTokens } from '../src/context/tokens.ts';
import { parseDocument } from '../src/worlds/frontmatter.ts';
import { tempWorlds } from './helpers.ts';

const file = (data: Record<string, unknown>, body: string) =>
  `---\n${Object.entries(data)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')}\n---\n\n${body}\n`;

describe('upsertSection', () => {
  const body =
    '# Mira\n\nIntro.\n\n## Relationships\n\nTrusts nobody.\n\n### Old\n\nx\n\n## Items\n\nA knife.\n';

  it('appends to and replaces an existing section, keeping subsections and later sections', () => {
    expect(upsertSection(body, 'Relationships', 'Owes Ash a favor.', 'append')).toContain(
      '## Relationships\n\nTrusts nobody.\n\n### Old\n\nx\n\nOwes Ash a favor.\n\n## Items',
    );
    const replaced = upsertSection(body, 'relationships', 'Trusts Ash.', 'replace');
    expect(replaced).toContain('## Relationships\n\nTrusts Ash.\n\n## Items\n\nA knife.');
    expect(replaced).not.toContain('Trusts nobody');
  });

  it('drops a heading the model repeated at the top of the text', () => {
    const result = upsertSection('# Mira\n', 'History', '## History\n\nMet Ash.', 'append');
    expect(result).toBe('# Mira\n\n## History\n\nMet Ash.\n');
  });

  it('adds a missing section at the end', () => {
    expect(upsertSection(body, 'Scars', 'A burn on the left hand.', 'append')).toMatch(
      /A knife\.\n\n## Scars\n\nA burn on the left hand\.\n$/,
    );
  });
});

describe('applyOps', () => {
  it('changes bodies and frontmatter, creates typed files and reports what it skipped', () => {
    const current = new Map([
      [
        'characters/mira.md',
        file({ type: 'character', name: 'Mira', tags: [], aliases: [] }, '# Mira'),
      ],
    ]);
    const result = applyOps(current, [
      {
        op: 'append_section',
        path: 'characters/mira.md',
        heading: 'Relationships',
        text: 'Owes Ash.',
      },
      { op: 'add_alias', path: 'characters/mira.md', alias: 'The Fox' },
      { op: 'set_summary', path: 'characters/mira.md', text: 'A smuggler.' },
      {
        op: 'create',
        path: 'places/harbor',
        name: 'Harbor',
        summary: 'Wet.',
        tags: ['port'],
        body: 'Docks.',
      },
      { op: 'set_summary', path: 'lore/missing.md', text: 'x' },
      { op: 'create', path: '../escape.md', name: 'x', summary: '', tags: [], body: '' },
    ]);
    const mira = parseDocument(result.files.get('characters/mira.md') ?? '');
    expect(mira.data).toMatchObject({ aliases: ['The Fox'], summary: 'A smuggler.' });
    expect(mira.body).toContain('## Relationships\n\nOwes Ash.');
    const harbor = parseDocument(result.files.get('places/harbor.md') ?? '');
    expect(harbor.data).toMatchObject({ type: 'place', name: 'Harbor', tags: ['port'] });
    expect(harbor.body).toBe('# Harbor\n\nDocks.\n');
    expect(result.skipped.map((s) => s.reason)).toEqual(['file does not exist', 'invalid path']);
  });
});

describe('mergeThreeWay', () => {
  it('merges independent changes and reports overlapping ones', async () => {
    const base = 'a\nb\nc\nd\ne\n';
    expect(await mergeThreeWay('A\nb\nc\nd\ne\n', base, 'a\nb\nc\nd\nE\n')).toEqual({
      text: 'A\nb\nc\nd\nE\n',
      conflicts: false,
    });
    const conflict = await mergeThreeWay('a\nX\nc\nd\ne\n', base, 'a\nY\nc\nd\ne\n');
    expect(conflict.conflicts).toBe(true);
    expect(conflict.text).toContain('<<<<<<< current');
  });
});

describe('selectCanon', () => {
  async function world() {
    const worlds = await tempWorlds();
    const { id } = await worlds.create('W');
    await worlds.write(
      id,
      'world.md',
      file({ id, type: 'world', name: 'W', summary: 'A rainy port.' }, 'Rain. '.repeat(50)),
    );
    await worlds.write(
      id,
      'characters/mira.md',
      file(
        { type: 'character', name: 'Mira', summary: '{{char}} smuggles.' },
        '{{char}} smuggles things. '.repeat(20),
      ),
    );
    await worlds.write(
      id,
      'characters/tomas.md',
      file(
        { type: 'character', name: 'Tomas', aliases: ['the captain'], summary: 'A captain.' },
        'Tomas commands the guard. '.repeat(20),
      ),
    );
    await worlds.write(
      id,
      'lore/moon.md',
      file(
        { type: 'lore', name: 'The Moon', tags: ['moon'], summary: 'It is red.' },
        'The moon is red. '.repeat(20),
      ),
    );
    await worlds.write(
      id,
      'lore/off.md',
      file(
        { type: 'lore', name: 'Off', tags: ['moon'], enabled: false, summary: 'x' },
        'Disabled.',
      ),
    );
    for (const n of [1, 2, 3]) {
      await worlds.write(
        id,
        `events/c-scene-${n}.md`,
        file(
          { type: 'event', name: `Scene ${n}`, chat: 'chat-1', order: n, summary: `S${n}.` },
          `Event ${n}. `.repeat(20),
        ),
      );
    }
    await worlds.write(
      id,
      'events/other.md',
      file(
        { type: 'event', name: 'Other chat', chat: 'chat-2', order: 1, summary: 'x' },
        'Elsewhere.',
      ),
    );
    return { worlds, id };
  }

  it('matches whole words only', () => {
    expect(mentions('The captain nods.', ['the captain'])).toBe(true);
    expect(mentions('Moonlight', ['moon'])).toBe(false);
  });

  it('picks files by priority within a generous budget', async () => {
    const { worlds, id } = await world();
    const selection = await selectCanon(worlds, {
      worldId: id,
      chatId: 'chat-1',
      cast: ['mira'],
      recentText: 'Under the moon, the captain waits.',
      budget: 100_000,
    });
    expect(selection.entries.map((e) => e.path)).toEqual([
      'world.md',
      'user.md',
      'characters/mira.md',
      'events/c-scene-2.md',
      'events/c-scene-3.md',
      'characters/tomas.md',
      'lore/moon.md',
      'events/c-scene-1.md',
    ]);
    expect(selection.text).toContain('Mira smuggles things.');
  });

  it('downgrades to summaries from the bottom, then drops, and never drops priority 1', async () => {
    const { worlds, id } = await world();
    const request = {
      worldId: id,
      chatId: 'chat-1',
      cast: ['mira'],
      recentText: 'moon, the captain',
    };
    const full = await selectCanon(worlds, { ...request, budget: 100_000 });

    const tight = await selectCanon(worlds, { ...request, budget: full.tokens - 50 });
    expect(tight.tokens).toBeLessThanOrEqual(full.tokens - 50);
    expect(tight.entries.at(-1)).toEqual({ path: 'events/c-scene-1.md', mode: 'short' });
    expect(tight.entries[0]).toEqual({ path: 'world.md', mode: 'full' });

    const minimal = await selectCanon(worlds, { ...request, budget: 10 });
    expect(minimal.entries.filter((e) => e.mode !== 'dropped').map((e) => e.path)).toEqual([
      'world.md',
      'user.md',
      'characters/mira.md',
    ]);
    expect(minimal.entries.slice(0, 3).every((e) => e.mode === 'short')).toBe(true);
    expect(minimal.text).toContain('A rainy port.');
    expect(countTokens(minimal.text)).toBeGreaterThan(10); // priority 1 stays even over budget
  });
});
