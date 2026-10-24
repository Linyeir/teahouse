import { NARRATOR_SPEAKER, type PathMessage, USER_SPEAKER } from '@teahouse/shared';
import { describe, expect, it } from 'vitest';
import { vnPages } from './vn.ts';

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
      (who) => slugs[who.toLowerCase()] ?? null,
    );
    expect(page?.stage.present).toEqual([
      { who: 'mira', mood: 'amused' },
      { who: 'tomas', mood: null },
    ]);
  });
});
