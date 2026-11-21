import { describe, expect, it } from 'vitest';
import { withoutFiles } from './themeFiles.ts';

describe('withoutFiles', () => {
  it('keeps the colors of a theme too large for localStorage', () => {
    const css = `@font-face {
  font-family: "Lora";
  src: url("data:font/woff2;base64,d09GMg==") format("woff2");
}

:root[data-preset="mine"][data-theme] {
  --color-bg: #123;
  --page-background: url("data:image/png;base64,iVBO") center / cover, #123;
}`;
    expect(withoutFiles(css)).toBe(`:root[data-preset="mine"][data-theme] {
  --color-bg: #123;
  --page-background: none center / cover, #123;
}`);
  });
});
