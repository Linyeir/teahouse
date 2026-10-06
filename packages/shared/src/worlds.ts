import { z } from 'zod';
import { id } from './api.ts';

export const canonTypes = ['world', 'user', 'character', 'place', 'event', 'lore'] as const;
export type CanonType = (typeof canonTypes)[number];

export const worldInput = z.object({ name: z.string().trim().min(1).max(100) });
export type WorldInput = z.infer<typeof worldInput>;

export const world = z.object({
  id,
  name: z.string(),
  folder: z.string(),
  summary: z.string(),
  /** Theme token overrides from `theme:` in world.md, e.g. `vn-textbox-bg: "#102030cc"`. */
  theme: z.record(z.string(), z.string()),
});
export type World = z.infer<typeof world>;

/** Path of a canon file relative to its world folder, e.g. `characters/mira.md`. */
export const canonPath = z
  .string()
  .min(4)
  .max(300)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\\0]+\.md$/, 'Must be a relative .md path');

export const canonFile = z.object({
  path: z.string(),
  type: z.string().nullable(),
  name: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  aliases: z.array(z.string()),
  /** Frontmatter could not be parsed. */
  error: z.string().nullable(),
});
export type CanonFile = z.infer<typeof canonFile>;

export const fileContent = z.object({ path: z.string(), content: z.string() });
export type FileContent = z.infer<typeof fileContent>;

export const fileWrite = z.object({ path: canonPath, content: z.string().max(1_000_000) });
export type FileWrite = z.infer<typeof fileWrite>;

export const commit = z.object({ sha: z.string(), date: z.string(), message: z.string() });
export type Commit = z.infer<typeof commit>;

export const characterImage = z.object({ id: z.string(), label: z.string(), file: z.string() });
export type CharacterImage = z.infer<typeof characterImage>;

export const characterSummary = z.object({
  slug: z.string(),
  path: z.string(),
  name: z.string(),
  summary: z.string(),
  greetings: z.array(z.string()),
  images: z.array(characterImage),
});
export type CharacterSummary = z.infer<typeof characterSummary>;

export const cardImportResult = z.object({
  worldId: id,
  characterSlug: z.string(),
  files: z.array(z.string()),
});
export type CardImportResult = z.infer<typeof cardImportResult>;

export const worldBackground = z.object({
  id: z.string(),
  file: z.string(),
  description: z.string(),
});
export type WorldBackground = z.infer<typeof worldBackground>;

/** Default image labels suggested when uploading character images (concept, section 10). */
export const DEFAULT_IMAGE_LABELS = [
  'neutral',
  'happy',
  'amused',
  'sad',
  'angry',
  'surprised',
  'worried',
];

/**
 * Theme tokens a world may override (see docs/theming.md). Values are plain CSS values;
 * `url(` and characters that could end a declaration are refused.
 */
export const THEME_TOKENS = [
  'color-bg',
  'color-surface',
  'color-text',
  'color-text-muted',
  'color-accent',
  'font-body',
  'font-story',
  'vn-stage-bg',
  'vn-textbox-bg',
  'vn-textbox-color',
  'vn-textbox-border',
  'vn-textbox-radius',
  'vn-name-bg',
  'vn-name-color',
  'vn-font',
  'vn-font-size',
  'vn-sprite-height',
  'vn-sprite-dim',
] as const;

export function sanitizeTheme(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const allowed = new Set<string>(THEME_TOKENS);
  const theme: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const token = key.replace(/^--/, '');
    if (!allowed.has(token) || (typeof value !== 'string' && typeof value !== 'number')) continue;
    const css = String(value).trim();
    if (!css || css.length > 200 || /url\(|expression\(|[;{}<>\\]/i.test(css)) continue;
    theme[token] = css;
  }
  return theme;
}
