import { describe, expect, it } from 'vitest';
import { renderTemplate } from './template.ts';

describe('renderTemplate', () => {
  it('replaces placeholders case-insensitively', () => {
    expect(renderTemplate('{{char}} greets {{ USER }}.', { char: 'Mira', user: 'Ash' })).toBe(
      'Mira greets Ash.',
    );
  });

  it('keeps unknown placeholders', () => {
    expect(renderTemplate('{{memory}}', {})).toBe('{{memory}}');
  });
});
