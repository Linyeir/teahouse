/**
 * An uploaded theme's CSS without its inlined files: `@font-face` rules dropped, images
 * replaced by `none`. What is left is small enough for localStorage and the first paint.
 */
export function withoutFiles(css: string): string {
  return css.replace(/@font-face\s*\{[^}]*\}\s*/g, '').replace(/url\("data:[^"]*"\)/g, 'none');
}
