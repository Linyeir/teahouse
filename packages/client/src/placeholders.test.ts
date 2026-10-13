import { NARRATOR_SPEAKER } from '@teahouse/shared';
import { describe, expect, it } from 'vitest';
import { shownContent } from './placeholders.ts';

const ctx = {
  userName: 'Ash',
  names: new Map([
    ['mira', 'Mira'],
    ['tomas', 'Tomas'],
  ]),
  chatCharacter: 'Mira',
};

describe('shownContent', () => {
  it('fills in the persona and the character whose turn it was', () => {
    const text = '{{char}} nods at {{ user }}.';
    expect(shownContent({ content: text, speaker: 'tomas' }, ctx)).toBe('Tomas nods at Ash.');
    expect(shownContent({ content: text, speaker: 'elsa' }, ctx)).toBe('elsa nods at Ash.');
  });

  it("uses the chat's character for start messages, older replies and the narrator", () => {
    const text = '{{char}} looks up. "{{user}}?"';
    expect(shownContent({ content: text, speaker: null }, ctx)).toBe('Mira looks up. "Ash?"');
    expect(shownContent({ content: text, speaker: NARRATOR_SPEAKER }, ctx)).toBe(
      'Mira looks up. "Ash?"',
    );
  });

  it('leaves other placeholders and plain text alone', () => {
    expect(shownContent({ content: 'A {{mood}} day.', speaker: null }, ctx)).toBe(
      'A {{mood}} day.',
    );
  });
});
