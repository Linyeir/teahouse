import { describe, expect, it } from 'vitest';
import { isLoopback, plainHttpWarning } from '../src/config.ts';

describe('plain HTTP warning', () => {
  it('stays quiet on loopback addresses', () => {
    for (const host of ['127.0.0.1', '127.0.1.1', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(isLoopback(host), host).toBe(true);
      expect(plainHttpWarning(host), host).toBeNull();
    }
  });

  it('warns on addresses other machines can reach', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'teahouse.lan', '127.example.com']) {
      expect(isLoopback(host), host).toBe(false);
      expect(plainHttpWarning(host), host).toContain('docs/https.md');
    }
  });
});
