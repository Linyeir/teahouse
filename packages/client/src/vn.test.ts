import { NARRATOR_SPEAKER, type PathMessage, USER_SPEAKER } from '@teahouse/shared';
import { describe, expect, it } from 'vitest';
import { greetingBeats, stageKeyAction, vnPages } from './vn.ts';

let n = 0;
const msg = (
  role: PathMessage['role'],
  content: string,
  speaker: string | null = null,
  status: PathMessage['status'] = 'complete',
): PathMessage => ({
  id: `m${++n}`,
  chatId: 'c',
  parentId: null,
  role,
  content,
  speaker,
  status,
  error: null,
  createdAt: '',
  updatedAt: '',
  revision: 1,
  siblingIds: [],
});

describe('vnPages', () => {
  it('puts each message on one page, with narration and lines together', () => {
    const pages = vnPages(
      [
        msg('assistant', '<narration>Mira looks up.</narration>'),
        msg('user', '*I sit.* Hello.'),
        msg(
          'assistant',
          '<narration>Tomas nods.</narration><say who="tomas">Rooms?</say>',
          'tomas',
        ),
      ],
      ['mira'],
      new Set(),
    );
    expect(pages).toHaveLength(3);
    // The start message only narrates, so no name.
    expect(pages.map((p) => p.speaker)).toEqual([null, USER_SPEAKER, 'tomas']);
    expect(pages[2]?.beats.map((b) => b.text)).toEqual(['Tomas nods.', 'Rooms?']);
    // Tomas joined with his turn.
    expect(pages[2]?.stage.present.map((p) => p.who)).toEqual(['mira', 'tomas']);
  });

  it('shows the stage after the whole message: last mood, known backgrounds only', () => {
    const [page] = vnPages(
      [
        msg(
          'assistant',
          '<bg id="docks"/><say who="mira" mood="amused">Hi.</say><bg id="nowhere"/><say who="mira" mood="angry">Late!</say>',
          'mira',
        ),
      ],
      ['mira'],
      new Set(['docks']),
    );
    expect(page?.stage.background).toBe('docks');
    expect(page?.stage.present).toEqual([{ who: 'mira', mood: 'angry' }]);
  });

  it('names nobody on the narrator turn or in an older reply with several speakers', () => {
    const pages = vnPages(
      [
        msg('assistant', '<narration>Thunder.</narration>', NARRATOR_SPEAKER),
        msg('assistant', '<say who="mira">Hi.</say><say who="tomas">Yo.</say>'),
        msg('assistant', '<narration>She waits.</narration><say who="mira">Well?</say>'),
      ],
      ['mira'],
      new Set(),
    );
    expect(pages.map((p) => p.speaker)).toEqual([null, null, 'mira']);
  });

  it('skips messages without text, but not a reply that is just starting', () => {
    const pages = vnPages(
      [msg('assistant', '<bg id="docks"/>', 'mira'), msg('assistant', '', 'mira', 'streaming')],
      ['mira'],
      new Set(['docks']),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]?.message.status).toBe('streaming');
    expect(pages[0]?.stage.background).toBe('docks');
  });
});

describe('greetingBeats', () => {
  const shape = (text: string) =>
    greetingBeats(text, 'mira').map((b) => (b.type === 'say' ? `say:${b.text}` : `n:${b.text}`));

  it('splits action and quoted speech', () => {
    expect(shape('*smiles* "Hello"')).toEqual(['n:smiles', 'say:Hello']);
    expect(shape('Mira looks up. “You came.” She waves.')).toEqual([
      'n:Mira looks up.',
      'say:You came.',
      'n:She waves.',
    ]);
  });

  it('reads unmarked text as speech when there are no quotes', () => {
    expect(shape('*waves* Hi there. *grins*')).toEqual(['n:waves', 'say:Hi there.', 'n:grins']);
  });
});

describe('vnPages with a greeting', () => {
  it('names the opener and splits the greeting, but leaves tagged greetings alone', () => {
    const greeting = msg('assistant', '*smiles* "Hello"');
    const [page] = vnPages([greeting], ['mira', 'tomas'], new Set(), {
      greeting: { messageId: greeting.id, opener: 'mira' },
    });
    expect(page?.speaker).toBe('mira');
    expect(page?.beats).toEqual([
      { type: 'narration', text: 'smiles', complete: true },
      { type: 'say', who: 'mira', mood: null, text: 'Hello', complete: true },
    ]);

    const tagged = msg('assistant', '<narration>Rain.</narration>');
    const [other] = vnPages([tagged], ['mira'], new Set(), {
      greeting: { messageId: tagged.id, opener: 'mira' },
    });
    expect(other?.beats.map((b) => b.type)).toEqual(['narration']);
  });

  it('starts on the given background until the narrator picks one', () => {
    const pages = vnPages(
      [msg('assistant', 'Hi.'), msg('assistant', '<bg id="docks"/>Rain.')],
      ['mira'],
      new Set(['docks', 'inn']),
      { background: 'inn' },
    );
    expect(pages.map((p) => p.stage.background)).toEqual(['inn', 'docks']);
  });
});

describe('vnPages with speakers by name', () => {
  it('shows one sprite per cast member when a reply names them differently', () => {
    const slugs: Record<string, string> = { mira: 'mira', tomas: 'tomas' };
    const [page] = vnPages(
      [
        msg(
          'assistant',
          '<say who="Mira" mood="amused">So.</say><narration>Tomas nods.</narration><say who="TOMAS">Aye.</say>',
          'mira',
        ),
      ],
      ['mira', 'tomas'],
      new Set(),
      { resolve: (who) => slugs[who.toLowerCase()] ?? null },
    );
    expect(page?.stage.present).toEqual([
      { who: 'mira', mood: 'amused' },
      { who: 'tomas', mood: null },
    ]);
  });
});

describe('stageKeyAction', () => {
  it('pages with Space, Enter and the arrows on the stage or with nothing focused', () => {
    for (const focus of ['stage', 'none'] as const) {
      expect(stageKeyAction(' ', focus)).toBe('advance');
      expect(stageKeyAction('Enter', focus)).toBe('advance');
      expect(stageKeyAction('ArrowRight', focus)).toBe('next');
      expect(stageKeyAction('ArrowLeft', focus)).toBe('back');
    }
  });

  it('leaves keys to a focused control elsewhere and to shortcuts', () => {
    for (const key of [' ', 'Enter', 'ArrowRight', 'ArrowLeft']) {
      expect(stageKeyAction(key, 'other')).toBeNull();
      expect(stageKeyAction(key, 'stage', true)).toBeNull();
    }
    expect(stageKeyAction('a', 'stage')).toBeNull();
  });
});
