import { createHash } from 'node:crypto';
import { extname, posix } from 'node:path';
import slugify from '@sindresorhus/slugify';
import type { ThemeMode, ThemeNote } from '@teahouse/shared';
import { z } from 'zod';
import { PackageError, type PackageFiles } from '../packages/zip.ts';
import { type Declaration, parseThemeCss, type ThemeBlock } from './css.ts';

/*
 * A theme package (docs/theming.md, "Build your own theme"): a ZIP with theme.css, an optional
 * theme.json, and the fonts and images the CSS uses. The result is one CSS file with every
 * file of the package inlined as a `data:` URL, so a device can keep it offline as one piece.
 */

/** Unpacked size limit of a theme package. */
export const MAX_THEME_BYTES = 50 * 1024 * 1024;
export const MAX_THEME_FILES = 500;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const FONT_FORMAT: Record<string, string> = {
  '.woff2': 'woff2',
  '.woff': 'woff',
  '.ttf': 'truetype',
  '.otf': 'opentype',
};

const font = z.object({
  family: z.string().regex(/^[^"'\\;{}<>]{1,100}$/),
  file: z.string(),
  weight: z
    .union([z.number(), z.string()])
    .transform(String)
    .pipe(z.string().regex(/^(normal|bold|\d{1,3}( \d{1,3})?)$/))
    .optional(),
  style: z.enum(['normal', 'italic', 'oblique']).optional(),
});

const manifest = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  author: z.string().trim().min(1).max(100).optional(),
  modes: z
    .array(z.enum(['light', 'dark']))
    .min(1)
    .max(2)
    .optional(),
  fonts: z.array(z.unknown()).optional(),
});

export interface BuiltTheme {
  /** The ID the package asks for; the store may change it if it is taken. */
  id: string;
  name: string;
  author: string | null;
  modes: ThemeMode[];
  /** Theme CSS with `{{selector}}` where the preset's selector goes. */
  template: string;
  notes: ThemeNote[];
}

export function buildTheme(files: PackageFiles): BuiltTheme {
  const notes: ThemeNote[] = [];
  const cssPath = files.has('theme.css')
    ? 'theme.css'
    : [...files.keys()].filter((f) => f.endsWith('.css')).length === 1
      ? [...files.keys()].find((f) => f.endsWith('.css'))
      : undefined;
  const cssFile = cssPath ? files.get(cssPath) : undefined;
  if (!cssPath || !cssFile) throw new PackageError('no-theme-css', 'The package has no theme.css');

  const meta = readManifest(files.get('theme.json'), notes);
  const base = posix.dirname(cssPath);
  const resolve = (path: string) => dataUrl(files, posix.join(base, path));
  const css = parseThemeCss(new TextDecoder().decode(cssFile), resolve);
  notes.push(...css.notes);

  const faces: string[] = [];
  for (const raw of meta.fonts ?? []) {
    const parsed = font.safeParse(raw);
    if (!parsed.success) {
      notes.push({ code: 'bad-manifest', detail: 'fonts' });
      continue;
    }
    const f = parsed.data;
    const ext = extname(f.file).toLowerCase();
    const url = FONT_FORMAT[ext] ? dataUrl(files, posix.normalize(f.file)) : null;
    if (!url) {
      notes.push({ code: 'missing-font', detail: f.file });
      continue;
    }
    faces.push(
      `@font-face {\n  font-family: "${f.family}";\n  src: url("${url}") format("${FONT_FORMAT[ext]}");\n` +
        `  font-weight: ${f.weight ?? 'normal'};\n  font-style: ${f.style ?? 'normal'};\n  font-display: swap;\n}`,
    );
  }

  const name = meta.name ?? meta.id ?? cssPath.replace(/\.css$/, '');
  return {
    id: themeId(meta.id ?? name),
    name,
    author: meta.author ?? null,
    modes: meta.modes ? [...new Set(meta.modes)] : inferModes(css.blocks),
    template: [...faces, ...blocksCss(css.blocks)].join('\n\n'),
    notes,
  };
}

function readManifest(file: Uint8Array | undefined, notes: ThemeNote[]) {
  if (!file) return {};
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(file));
  } catch {
    notes.push({ code: 'bad-manifest', detail: 'theme.json' });
    return {};
  }
  const parsed = manifest.safeParse(json);
  if (parsed.success) return parsed.data;
  // Keep what is usable: a wrong `modes` should not cost the theme its name.
  notes.push({ code: 'bad-manifest', detail: parsed.error.issues[0]?.path.join('.') ?? '' });
  const out: z.infer<typeof manifest> = {};
  for (const key of Object.keys(manifest.shape) as (keyof typeof manifest.shape)[]) {
    const field = manifest.shape[key].safeParse((json as Record<string, unknown>)?.[key]);
    if (field.success && field.data !== undefined) Object.assign(out, { [key]: field.data });
  }
  return out;
}

export function themeId(text: string): string {
  const id = slugify(text).slice(0, 60).replace(/-+$/, '');
  return id || 'theme';
}

function inferModes(blocks: Record<ThemeBlock, Declaration[]>): ThemeMode[] {
  const lightish = blocks.base.length > 0 || blocks.light.length > 0;
  const darkScheme = blocks.base.some((d) => d.property === 'color-scheme' && d.value === 'dark');
  if (blocks.dark.length > 0) return lightish && !darkScheme ? ['light', 'dark'] : ['dark'];
  return darkScheme ? ['dark'] : ['light'];
}

/**
 * The blocks under the preset's selector. `[data-theme]` and the doubled `:root` raise the
 * specificity above the defaults in global.css, which set dark values under
 * `:root[data-theme="dark"]`, whichever style sheet comes last.
 */
function blocksCss(blocks: Record<ThemeBlock, Declaration[]>): string[] {
  const out: string[] = [];
  const selectors: Record<ThemeBlock, string> = {
    base: ':root{{selector}}[data-theme]',
    light: ':root{{selector}}[data-theme="light"]:root',
    dark: ':root{{selector}}[data-theme="dark"]:root',
  };
  for (const block of ['base', 'light', 'dark'] as const) {
    if (blocks[block].length === 0) continue;
    const body = blocks[block].map((d) => `  ${d.property}: ${d.value};`).join('\n');
    out.push(`${selectors[block]} {\n${body}\n}`);
  }
  return out;
}

function dataUrl(files: PackageFiles, path: string): string | null {
  const data = files.get(path);
  const mime = MIME[extname(path).toLowerCase()];
  if (!data || !mime) return null;
  return `data:${mime};base64,${Buffer.from(data).toString('base64')}`;
}

/** The final CSS of a theme installed under `id`. */
export function themeCss(template: string, id: string): string {
  return template.replaceAll('{{selector}}', `[data-preset="${id}"]`);
}

export const cssHash = (css: string) => createHash('sha256').update(css).digest('hex').slice(0, 16);
