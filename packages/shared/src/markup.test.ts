import { describe, expect, it } from 'vitest';
import {
  defaultSpeaker,
  findForeignLine,
  NARRATOR_SPEAKER,
  normalizeSpeakers,
  parseMarkup,
  parseUserInput,
  sceneStage,
  stageAfter,
  USER_SPEAKER,
} from './markup.ts';

describe('parseMarkup', () => {
  it('parses the documented tags', () => {
    const beats = parseMarkup(
      '<bg id="tavern-night"/>\n<narration>Rain drums.</narration>\n<say who="mira" mood="amused">So you came.</say>\n<leave who="tomas"/>',
    );
    expect(beats).toEqual([
      { type: 'bg', id: 'tavern-night' },
      { type: 'narration', text: 'Rain drums.', complete: true },
      { type: 'say', who: 'mira', mood: 'amused', text: 'So you came.', complete: true },
      { type: 'leave', who: 'tomas' },
    ]);
  });

  it('treats untagged text as narration and merges it with neighbouring narration', () => {
    expect(parseMarkup('Plain prose.\n\nMore prose.')).toEqual([
      { type: 'narration', text: 'Plain prose.\n\nMore prose.', complete: true },
    ]);
    expect(
      parseMarkup('<narration>A.</narration> B. <say who="mira">Hi.</say>').map((b) => b.type),
    ).toEqual(['narration', 'say']);
  });

  it('is lenient: unclosed tags, a new tag closing the open one, stray and unknown tags', () => {
    const beats = parseMarkup(
      '<say who="mira">One<say who=tomas mood=angry>Two</narration> <b>bold</b>',
    );
    expect(beats).toEqual([
      { type: 'say', who: 'mira', mood: null, text: 'One', complete: true },
      { type: 'say', who: 'tomas', mood: 'angry', text: 'Two <b>bold</b>', complete: true },
    ]);
  });

  it('drops reasoning blocks', () => {
    expect(parseMarkup('<think>plan the scene</think><narration>Dusk.</narration>')).toEqual([
      { type: 'narration', text: 'Dusk.', complete: true },
    ]);
  });

  it('drops reasoning whose opening tag the server cut off, and <thinking> blocks', () => {
    expect(parseMarkup('Mira should greet them.\n</think><say who="mira">Hi</say>')).toEqual([
      { type: 'say', who: 'mira', mood: null, text: 'Hi', complete: true },
    ]);
    expect(parseMarkup('<thinking>Who talks?</thinking>\n<say who="mira">Hi</say>')).toEqual([
      { type: 'say', who: 'mira', mood: null, text: 'Hi', complete: true },
    ]);
    // While the reasoning still streams, none of it shows.
    expect(parseMarkup('<thinking>Who talks', { final: false })).toEqual([]);
  });

  it('marks the open beat incomplete while streaming and hides a half-written tag', () => {
    expect(
      parseMarkup('<narration>Rain.</narration><say who="mira" mood="amu', { final: false }),
    ).toEqual([{ type: 'narration', text: 'Rain.', complete: true }]);
    expect(parseMarkup('<say who="mira">So you', { final: false })).toEqual([
      { type: 'say', who: 'mira', mood: null, text: 'So you', complete: false },
    ]);
  });
});

describe('parseUserInput', () => {
  it('splits *actions* from speech', () => {
    expect(parseUserInput('*I sit down.* Long night? *I wave.*')).toEqual([
      { type: 'narration', text: 'I sit down.', complete: true },
      { type: 'say', who: USER_SPEAKER, mood: null, text: 'Long night?', complete: true },
      { type: 'narration', text: 'I wave.', complete: true },
    ]);
  });
});

describe('findForeignLine', () => {
  it('finds the first line by someone the test rejects', () => {
    const notMira = (who: string) => who.toLowerCase() !== 'mira';
    const text =
      '<say who="Mira">Hi.</say><narration>Ash waits.</narration><say who="Ash">Fine.</say>';
    expect(findForeignLine(text, notMira)).toBe(text.lastIndexOf('<say'));
    expect(findForeignLine('<say who="mira">Ash?</say></say>', notMira)).toBeNull();
    expect(findForeignLine('<say>No speaker.</say>', notMira)).toBeNull();
  });
});

describe('stageAfter', () => {
  it('tracks background, who is present with their mood, and the speaker', () => {
    const state = stageAfter(
      parseMarkup(
        '<bg id="docks"/><say who="mira" mood="neutral">Hi.</say><say who="tomas">Yo.</say><say who="mira" mood="angry">Late!</say><leave who="tomas"/>',
      ),
    );
    expect(state).toEqual({
      background: 'docks',
      present: [{ who: 'mira', mood: 'angry' }],
      speaker: 'mira',
    });
  });
});

describe('sceneStage', () => {
  const reply = (content: string, speaker: string | null) => ({
    role: 'assistant' as const,
    content,
    speaker,
  });

  it('brings a speaker on stage even when they only act', () => {
    const state = sceneStage(
      [
        reply('<narration>Mira looks up.</narration>', null),
        { role: 'user', content: 'Hello?', speaker: null },
        reply('<narration>Tomas nods.</narration>', 'tomas'),
        reply('<narration>Thunder.</narration>', NARRATOR_SPEAKER),
      ],
      ['mira'],
    );
    expect(state.present.map((p) => p.who)).toEqual(['mira', 'tomas']);
  });
});

describe('defaultSpeaker', () => {
  it('is whoever had the last turn, skipping the narrator, else the first of the cast', () => {
    const turn = (speaker: string | null) => ({ role: 'assistant' as const, content: '', speaker });
    expect(defaultSpeaker([turn('tomas'), turn(NARRATOR_SPEAKER), turn(null)], ['mira'])).toBe(
      'tomas',
    );
    expect(defaultSpeaker([turn(null)], ['mira', 'tomas'])).toBe('mira');
    expect(defaultSpeaker([], [])).toBe(NARRATOR_SPEAKER);
  });
});

describe('markupToText', () => {
  it('renders beats as prose and named lines', async () => {
    const { markupToText } = await import('./markup.ts');
    expect(
      markupToText(
        '<narration>Rain.</narration><say who="mira">Hi.</say><leave who="mira"/>',
        new Map([['mira', 'Mira']]),
      ),
    ).toBe('Rain.\nMira: Hi.\n(Mira leaves.)');
  });
});

describe('sanitizeTheme', () => {
  it('keeps known tokens with plain values and drops everything else', async () => {
    const { sanitizeTheme } = await import('./worlds.ts');
    expect(
      sanitizeTheme({
        'vn-textbox-bg': '#102030cc',
        '--vn-font-size': 18,
        'vn-stage-bg': 'url(https://tracker.example/x.png)',
        'vn-name-color': 'red; background: blue',
        position: 'fixed',
      }),
    ).toEqual({ 'vn-textbox-bg': '#102030cc', 'vn-font-size': '18' });
  });
});

describe('normalizeSpeakers', () => {
  const slugs: Record<string, string> = { mira: 'mira', 'mira vale': 'mira', red: 'mira' };
  const resolve = (who: string) => slugs[who.toLowerCase()] ?? null;

  it('stores names, other casing and aliases as the slug', () => {
    expect(
      normalizeSpeakers(
        '<say who="Mira" mood="sad">A</say><say who=\'MIRA\'>B</say><say who=Red>C</say><leave who="Mira Vale"/>',
        resolve,
      ),
    ).toBe(
      '<say who="mira" mood="sad">A</say><say who="mira">B</say><say who="mira">C</say><leave who="mira"/>',
    );
  });

  it('leaves unknown speakers, other tags and text alone', () => {
    const text = '<narration>who="Mira"</narration><say who="ghost">Boo</say>';
    expect(normalizeSpeakers(text, resolve)).toBe(text);
  });
});
