import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import de from './locales/de.json';
import en from './locales/en.json';

vi.stubGlobal('window', new EventTarget());
vi.stubGlobal('navigator', { language: 'en', userAgent: '' });
const i18n = (await import('./i18n.ts')).default;

/** Every string of a locale with its key, e.g. ["settings.userName", "Your name in stories"]. */
function strings(tree: object, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [[`${prefix}${key}`, value] as [string, string]]
      : strings(value as object, `${prefix}${key}.`),
  );
}

const src = new URL('.', import.meta.url).pathname;
/** Keys the code passes to t() as plain strings, e.g. t('worlds.imported'). */
const usedKeys = [
  ...new Set(
    (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .flatMap((f) =>
        [...readFileSync(join(src, f), 'utf8').matchAll(/\bt\(\s*'([\w.]+)'/g)].map((m) => m[1]),
      ),
  ),
] as string[];

// #59: copy that reads as finished.
describe.each([
  ['en', en],
  ['de', de],
])('locale %s', (lang, tree) => {
  it('has every key the code uses', () => {
    const known = new Set(strings(tree).map(([key]) => key.replace(/_(one|other)$/, '')));
    expect(usedKeys.length).toBeGreaterThan(100);
    expect(usedKeys.filter((key) => !known.has(key))).toEqual([]);
  });

  it('shows no template braces such as {{user}}', () => {
    expect(strings(tree).filter(([, text]) => text.includes('{{'))).toEqual([]);
  });

  it('counts files and things in proper plurals', async () => {
    const t = await i18n.cloneInstance().changeLanguage(lang);
    for (const key of ['scenes.apply', 'scenes.learned']) {
      const one = t(key, { count: 1 });
      const two = t(key, { count: 2 });
      expect(one).toContain('1');
      expect(two).toContain('2');
      expect(one.replace('1', '')).not.toBe(two.replace('2', ''));
    }
  });
});
