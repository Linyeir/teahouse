import { describe, expect, it } from 'vitest';
import { contrast, NAME_PRESETS, NAME_TEXT, namePreset } from './nameColors.ts';

const TEXT_LIGHT = NAME_TEXT.light;
const TEXT_DARK = NAME_TEXT.dark;

describe('name presets', () => {
  it('pass 4.5:1 against the badge text in both themes', () => {
    for (const preset of NAME_PRESETS) {
      expect(contrast(preset.light, TEXT_LIGHT)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(preset.dark, TEXT_DARK)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives a slug the same preset every time, and different slugs different ones', () => {
    expect(namePreset('mira')).toBe(namePreset('mira'));
    const used = new Set(['mira', 'tomas', 'ines', 'kai', 'aldo', 'bea'].map(namePreset));
    expect(used.size).toBeGreaterThan(2);
  });
});
