import type { Beat } from '@teahouse/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BeatsText, moodsBefore } from './Beats.tsx';

const names = new Map([
  ['mira', 'Mira'],
  ['tomas', 'Tomas'],
]);
const say = (who: string, text: string, mood: string | null = null): Beat => ({
  type: 'say',
  who,
  mood,
  text,
  complete: true,
});
const render = (
  beats: Beat[],
  speaker: string | null,
  moods: ReadonlyMap<string, string> = new Map(),
) =>
  renderToStaticMarkup(
    <BeatsText beats={beats} names={names} userName="Ann" speaker={speaker} moods={moods} />,
  );

describe('BeatsText in the log', () => {
  it('drops the name on lines of the message speaker, as the novel view does', () => {
    const html = render([say('mira', 'Hi.'), say('tomas', 'Yo.')], 'mira');
    expect(html).not.toContain('Mira');
    expect(html).toContain('Tomas');
  });

  it('shows a mood only when it changes, also across messages', () => {
    const first = render([say('mira', 'A.', 'neutral'), say('mira', 'B.', 'neutral')], 'mira');
    expect(first.match(/neutral/g)).toHaveLength(1);
    const messages = [
      {
        id: 'a',
        role: 'assistant',
        status: 'complete',
        content: '<say who="mira" mood="neutral">A.</say>',
      },
      {
        id: 'b',
        role: 'assistant',
        status: 'complete',
        content: '<say who="mira" mood="neutral">B.</say>',
      },
    ];
    const before = moodsBefore(messages).get('b');
    expect(render([say('mira', 'B.', 'neutral')], 'mira', before)).not.toContain('neutral');
    expect(render([say('mira', 'C.', 'amused')], 'mira', before)).toContain('amused');
  });
});
