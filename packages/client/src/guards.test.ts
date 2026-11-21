import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = new URL('.', import.meta.url).pathname;
const files = (readdirSync(src, { recursive: true }) as string[]).filter(
  (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f),
);

describe('guards', () => {
  // #57: the browser's prompt and confirm look different in every shell and may not work in the
  // Android WebView; Dialog.tsx and ConfirmDialog stand in for them.
  it('uses no window.prompt or window.confirm', () => {
    const found = files.filter((f) =>
      /\bwindow\.(prompt|confirm)\s*\(/.test(readFileSync(join(src, f), 'utf8')),
    );
    expect(found).toEqual([]);
  });

  // Shared controls take every color from a token (docs/theming.md), so all themes reach them.
  it('keeps colors in the shared controls to tokens', () => {
    const css = readFileSync(join(src, 'components/ui.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const literal = css.match(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|color-mix)\(/gi);
    expect(literal).toBeNull();
  });
});
