import { describe, expect, it } from 'vitest';
import { isThemePreset, resolveThemeMode } from './themes.ts';

describe('resolveThemeMode', () => {
  it('follows the system unless light or dark is chosen', () => {
    expect(resolveThemeMode('standard', 'system', false)).toBe('light');
    expect(resolveThemeMode('standard', 'system', true)).toBe('dark');
    expect(resolveThemeMode('standard', 'light', true)).toBe('light');
    expect(resolveThemeMode('standard', 'dark', false)).toBe('dark');
  });

  it('keeps a one-mode preset in its mode', () => {
    expect(resolveThemeMode('sakura', 'dark', true)).toBe('light');
    expect(resolveThemeMode('cyberpunk', 'light', false)).toBe('dark');
    expect(resolveThemeMode('nord', 'dark', false)).toBe('dark');
  });
});

describe('isThemePreset', () => {
  it('accepts known presets only', () => {
    expect(isThemePreset('gothic')).toBe(true);
    expect(isThemePreset('Gothic')).toBe(false);
    expect(isThemePreset(null)).toBe(false);
  });
});
