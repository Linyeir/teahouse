import { posix } from 'node:path';
import type { CanonFile } from '@teahouse/shared';
import { renderTemplate } from '@teahouse/shared';
import { parseDocument, stringValue } from '../worlds/frontmatter.ts';
import type { WorldService } from '../worlds/service.ts';
import { countTokens } from './tokens.ts';

/** Share of the context window the canon may use by default (concept, section 5). */
export const CANON_BUDGET_SHARE = 0.3;

interface Entry {
  path: string;
  name: string;
  priority: 1 | 2 | 3 | 4;
  full: string;
  short: string;
  mode: 'full' | 'short' | 'dropped';
}

export interface CanonSelection {
  text: string;
  tokens: number;
  /** Which files went in and how, for debugging and tests. */
  entries: { path: string; mode: Entry['mode'] }[];
}

export interface CanonRequest {
  worldId: string;
  chatId: string;
  cast: string[];
  /** Recent story text (start message, memory, latest turns) to match tags and aliases. */
  recentText: string;
  budget: number;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-insensitive match of any keyword in `text`. */
export function mentions(text: string, keywords: string[]): boolean {
  return keywords.some((k) => {
    const word = k.trim();
    if (word.length < 2) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(word)}($|[^\\p{L}\\p{N}])`, 'iu').test(
      text,
    );
  });
}

/**
 * Picks the canon for a prompt, by priority:
 * 1. world.md, user.md and the files of all present characters
 * 2. the last two events/ files of this chat
 * 3. files whose tags, aliases or name appear in the recent story text
 * 4. older events/ files
 * When over budget, entries are downgraded to their summary from the bottom up, then dropped.
 * Priority 1 is downgraded last and never dropped.
 */
export async function selectCanon(
  worlds: WorldService,
  req: CanonRequest,
): Promise<CanonSelection> {
  const files = await worlds.files(req.worldId);
  const castPaths = new Set(req.cast.map((slug) => `characters/${slug}.md`));
  const isEvent = (f: CanonFile) => f.type === 'event' || f.path.startsWith('events/');

  const contents = new Map<string, ReturnType<typeof parseDocument>>();
  for (const file of files) {
    contents.set(file.path, parseDocument(await worlds.read(req.worldId, file.path)));
  }
  const enabled = (f: CanonFile) => contents.get(f.path)?.data.enabled !== false;

  const chatEvents = files
    .filter((f) => isEvent(f) && contents.get(f.path)?.data.chat === req.chatId)
    .sort(
      (a, b) => eventOrder(contents.get(a.path)?.data) - eventOrder(contents.get(b.path)?.data),
    );
  const recentEvents = new Set(chatEvents.slice(-2).map((f) => f.path));

  const priorityOf = (f: CanonFile): Entry['priority'] | null => {
    if (f.path === 'world.md' || f.path === 'user.md' || castPaths.has(f.path)) return 1;
    if (recentEvents.has(f.path)) return 2;
    if (!enabled(f)) return null;
    if (mentions(req.recentText, [...f.tags, ...f.aliases, f.name])) return 3;
    if (isEvent(f) && chatEvents.includes(f)) return 4;
    return null;
  };

  const entries: Entry[] = [];
  for (const file of files) {
    const priority = priorityOf(file);
    if (!priority) continue;
    const doc = contents.get(file.path);
    // In a character file, {{char}} is that character (concept, section 5).
    const own = (text: string) =>
      file.path.startsWith('characters/') ? renderTemplate(text, { char: file.name }) : text;
    const body = own(doc?.body.trim() ?? '');
    const summary = own(stringValue(doc?.data.summary).trim());
    entries.push({
      path: file.path,
      name: file.name,
      priority,
      full: body,
      short: summary || firstLines(body),
      mode: 'full',
    });
  }
  entries.sort(
    (a, b) =>
      a.priority - b.priority ||
      // Within priority 1: world, user, then characters in cast order.
      rank(a.path, req.cast) - rank(b.path, req.cast) ||
      a.path.localeCompare(b.path),
  );

  const render = () =>
    entries
      .filter((e) => e.mode !== 'dropped' && (e.mode === 'full' ? e.full : e.short))
      .map(
        (e) =>
          `<file path="${e.path}" name="${e.name}"${e.mode === 'short' ? ' summary="true"' : ''}>\n${
            e.mode === 'full' ? e.full : e.short
          }\n</file>`,
      )
      .join('\n\n');
  let text = render();
  let tokens = countTokens(text);

  const shrink = (pick: (e: Entry) => boolean, mode: Entry['mode']) => {
    for (let i = entries.length - 1; i >= 0 && tokens > req.budget; i--) {
      const entry = entries[i];
      if (!entry || !pick(entry)) continue;
      entry.mode = mode;
      text = render();
      tokens = countTokens(text);
    }
  };
  shrink((e) => e.priority > 1 && e.mode === 'full', 'short');
  shrink((e) => e.priority > 1 && e.mode !== 'dropped', 'dropped');
  shrink((e) => e.priority === 1 && e.mode === 'full', 'short');

  return { text, tokens, entries: entries.map((e) => ({ path: e.path, mode: e.mode })) };
}

function eventOrder(data: Record<string, unknown> | undefined): number {
  const order = data?.order;
  return typeof order === 'number' ? order : 0;
}

function rank(path: string, cast: string[]): number {
  if (path === 'world.md') return 0;
  if (path === 'user.md') return 1;
  const index = cast.indexOf(posix.basename(path, '.md'));
  return index === -1 ? 1000 : 2 + index;
}

function firstLines(body: string): string {
  return body
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .slice(0, 2)
    .join(' ')
    .slice(0, 300);
}
