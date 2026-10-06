import { describe, expect, it } from 'vitest';
import { findUserLine, parseMarkup, parseUserInput, stageAfter, USER_SPEAKER } from './markup.ts';

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

describe('findUserLine', () => {
  it('finds a line written for the persona', () => {
    const text = '<narration>Mira waits.</narration><say who="Ash">Fine.</say>';
    expect(findUserLine(text, ['Ash'])).toBe(text.indexOf('<say'));
    expect(findUserLine('<say who="user">x</say>', [])).toBe(0);
    expect(findUserLine('<say who="mira">Ash?</say>', ['Ash'])).toBeNull();
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
