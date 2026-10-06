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
