import { describe, expect, it } from 'vitest';
import { sanitizeColor } from './worlds.ts';

describe('sanitizeColor', () => {
  it('keeps hex, names and color functions', () => {
    for (const color of ['#8e3b46', '#abc', 'teal', 'rgb(10 20 30)', 'oklch(60% 0.1 30)']) {
      expect(sanitizeColor(color)).toBe(color);
    }
  });

  it('refuses anything that could load or inject', () => {
    for (const bad of ['url(x)', 'red; color: blue', 'rgb(1,2,3)}', '', 12, null]) {
      expect(sanitizeColor(bad)).toBeNull();
    }
  });
});
