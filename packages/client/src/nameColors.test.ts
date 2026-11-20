import { describe, expect, it } from 'vitest';
import { contrast, NAME_PRESETS, namePreset } from './nameColors.ts';

// --vn-name-color is --color-accent-text: see global.css.
const TEXT_LIGHT = '#ffffff';
const TEXT_DARK = '#1b1916';

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
