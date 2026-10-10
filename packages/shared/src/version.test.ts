import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json' with { type: 'json' };
import { compatibility, TEAHOUSE_VERSION } from './version.ts';

describe('version', () => {
  it('matches the root package.json', () => {
    expect(TEAHOUSE_VERSION).toBe(pkg.version);
  });

  it('names the side to update', () => {
    expect(compatibility(2, 2)).toBe('ok');
    expect(compatibility(1, 2)).toBe('update-server');
    expect(compatibility(3, 2)).toBe('update-app');
  });
});
