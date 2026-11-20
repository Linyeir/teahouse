import { posix } from 'node:path';
import { z } from 'zod';
import { parseDocument, stringifyDocument, stringList } from '../worlds/frontmatter.ts';

const path = z.string().min(4).max(200);

/**
 * Structured canon changes (concept, section 8). The LLM never rewrites whole files, so it
 * cannot silently drop content; frontmatter is changed only by code.
 */
export const canonOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    path,
    name: z.string().min(1),
    summary: z.string(),
    tags: z.array(z.string()).default([]),
    body: z.string(),
  }),
  z.object({ op: z.literal('append_section'), path, heading: z.string().min(1), text: z.string() }),
  z.object({
    op: z.literal('replace_section'),
    path,
    heading: z.string().min(1),
    text: z.string(),
  }),
  z.object({ op: z.literal('set_summary'), path, text: z.string() }),
  z.object({ op: z.literal('add_alias'), path, alias: z.string().min(1) }),
  z.object({ op: z.literal('add_tag'), path, tag: z.string().min(1) }),
]);

/**
 * Operations only a cleanup run may propose. `merge` folds the file `from` into `path` and
 * deletes it; code does the merging, so nothing of either file is lost. `fix_contradiction`
 * replaces a section like `replace_section` and names what the other file says, for review.
 */
export const cleanupOp = z.discriminatedUnion('op', [
  ...canonOp.options,
  z.object({ op: z.literal('merge'), path, from: path }),
  z.object({
    op: z.literal('fix_contradiction'),
    path,
    heading: z.string().min(1),
    text: z.string(),
    other: path,
    other_quote: z.string().min(1),
  }),
]);
export type CanonOp = z.infer<typeof cleanupOp>;

export const canonUpdate = z.object({
  event: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    body: z.string().min(1),
    tags: z.array(z.string()).default([]),
  }),
  operations: z.array(canonOp).default([]),
});
export type CanonUpdate = z.infer<typeof canonUpdate>;

export const cleanupUpdate = z.object({ operations: z.array(cleanupOp).default([]) });

export const canonUpdateJsonSchema = z.toJSONSchema(canonUpdate, {
  target: 'draft-7',
  io: 'input',
});

const TYPE_BY_FOLDER: Record<string, string> = {
  characters: 'character',
  places: 'place',
  events: 'event',
  lore: 'lore',
};

/** An operation that was not applied as proposed, and why. */
export type NoteCode =
  | 'invalid_path'
  | 'wrong_folder'
  | 'missing_file'
  | 'invalid_yaml'
  | 'unseen_summary'
  | 'unseen_replace'
  | 'alias_not_in_scene'
  | 'merge_not_allowed'
  | 'also_in_scene_proposal';

export interface OpNote {
  op: CanonOp;
  /** What happened, for the review to put into words. */
  code: NoteCode;
  /** `skipped`: left out. `downgraded`: applied in a safer form. `flagged`: applied, but worth a look. */
  outcome: 'skipped' | 'downgraded' | 'flagged';
  reason: string;
}

export interface ApplyResult {
  /** Path → new content, only for files that changed; null for a file merged into another. */
  files: Map<string, string | null>;
  /** Operations that were skipped or changed, with the reason. */
  notes: OpNote[];
}

/**
 * Applies operations to the given files (path → current content, missing = new file).
 * Pure: the caller decides what to write.
 *
 * `seen` lists the existing files the model had in full. Any other file may hold more than
 * the model knows, so it is only extended: a section replace becomes an append, and its
 * summary is left alone. Without `seen`, every file counts as seen.
 */
export function applyOps(
  current: Map<string, string>,
  ops: CanonOp[],
  seen?: Set<string>,
): ApplyResult {
  const files = new Map<string, string | null>();
  const notes: OpNote[] = [];
  const skip = (op: CanonOp, code: NoteCode, reason: string) =>
    notes.push({ op, code, outcome: 'skipped', reason });
  // A file merged away (null) is gone for every later operation.
  const get = (p: string) => (files.has(p) ? (files.get(p) ?? undefined) : current.get(p));
  const unseen = (p: string) => seen !== undefined && current.has(p) && !seen.has(p);

  for (const op of ops) {
    const target = normalizePath(op.path);
    if (!target) {
      skip(op, 'invalid_path', 'invalid path');
      continue;
    }
    const existing = get(target);

    if (op.op === 'create') {
      if (existing !== undefined) {
        // Already there: keep the existing file and add the new text as a section instead.
        const doc = parseDocument(existing);
        files.set(
          target,
          stringifyDocument({
            data: doc.data,
            body: upsertSection(doc.body, 'Update', op.body, 'append'),
          }),
        );
        continue;
      }
      const folder = target.split('/')[0] ?? '';
      const type = TYPE_BY_FOLDER[folder];
      if (!type) {
        skip(op, 'wrong_folder', 'new files belong in characters/, places/, events/ or lore/');
        continue;
      }
      const data: Record<string, unknown> = {
        type,
        name: op.name,
        tags: op.tags,
        aliases: [],
        summary: op.summary,
      };
      if (type === 'character') data.greetings = [];
      const body = op.body.trim().startsWith('#') ? op.body : `# ${op.name}\n\n${op.body}`;
      files.set(target, stringifyDocument({ data, body }));
      continue;
    }

    if (existing === undefined) {
      skip(op, 'missing_file', 'file does not exist');
      continue;
    }
    const doc = parseDocument(existing);
    if (doc.error) {
      skip(op, 'invalid_yaml', 'frontmatter is not valid YAML');
      continue;
    }
    if (op.op === 'merge') {
      const from = normalizePath(op.from);
      const other = from ? get(from) : undefined;
      if (!from || other === undefined) {
        skip(op, 'missing_file', 'the file to merge does not exist');
        continue;
      }
      const why = mergeRefusal(target, from);
      if (why) {
        skip(op, 'merge_not_allowed', why);
        continue;
      }
      const source = parseDocument(other);
      if (source.error) {
        skip(op, 'invalid_yaml', 'frontmatter of the file to merge is not valid YAML');
        continue;
      }
      files.set(target, stringifyDocument(mergeDocuments(doc, source)));
      files.set(from, null);
      continue;
    }
    if (op.op === 'set_summary' && unseen(target)) {
      skip(op, 'unseen_summary', 'the file was not read in full, so its summary stays');
      continue;
    }
    const replaces = op.op === 'replace_section' || op.op === 'fix_contradiction';
    const downgrade = replaces && unseen(target);
    if (downgrade) {
      notes.push({
        op,
        code: 'unseen_replace',
        outcome: 'downgraded',
        reason: 'the file was not read in full, so the section was added to instead of replaced',
      });
    }
    switch (op.op) {
      case 'append_section':
      case 'replace_section':
      case 'fix_contradiction':
        doc.body = upsertSection(
          doc.body,
          op.heading,
          op.text,
          op.op === 'append_section' || downgrade ? 'append' : 'replace',
        );
        break;
      case 'set_summary':
        doc.data.summary = op.text;
        break;
      case 'add_alias':
        doc.data.aliases = addUnique(stringList(doc.data.aliases), op.alias);
        break;
      case 'add_tag':
        doc.data.tags = addUnique(stringList(doc.data.tags), op.tag);
        break;
    }
    files.set(target, stringifyDocument(doc));
  }

  for (const [p, content] of files) {
    if (current.get(p) === content) files.delete(p);
  }
  return { files, notes };
}

/** Why `from` cannot be merged into `target`, or null if it can. */
function mergeRefusal(target: string, from: string): string | null {
  if (target === from) return 'a file cannot be merged into itself';
  const folder = (p: string) => (p.includes('/') ? p.split('/')[0] : '');
  if (!folder(target) || !folder(from)) return 'world.md and user.md are never merged';
  if (folder(target) === 'events' || folder(from) === 'events') return 'events are never merged';
  if (folder(target) !== folder(from)) return 'only files in the same folder are merged';
  return null;
}

type Doc = ReturnType<typeof parseDocument>;

/**
 * `source` folded into `target`: its name and aliases become aliases, tags, greetings and
 * images are added, and its body follows under a section of its own. Nothing is dropped.
 */
export function mergeDocuments(target: Doc, source: Doc): Doc {
  const data = { ...target.data };
  const name = String(target.data.name ?? '');
  const sourceName = String(source.data.name ?? '');
  const aliases = [sourceName, ...stringList(source.data.aliases)].filter(
    (a) => a && a.toLowerCase() !== name.toLowerCase(),
  );
  data.aliases = aliases.reduce(addUnique, stringList(target.data.aliases));
  data.tags = stringList(source.data.tags).reduce(addUnique, stringList(target.data.tags));
  for (const key of ['greetings', 'images'] as const) {
    const list = [...listOf(target.data[key]), ...listOf(source.data[key])];
    if (list.length) data[key] = uniqueEntries(list);
  }
  const text = source.body
    .trim()
    .replace(/^#\s+.*\n+/, '')
    .trim();
  const body = text
    ? upsertSection(target.body, `${sourceName || 'Merged'}`, text, 'append')
    : target.body;
  return { ...target, data, body };
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Entries without repeats; images with an ID already taken keep the first one. */
function uniqueEntries(list: unknown[]): unknown[] {
  const seen = new Set<string>();
  return list.filter((entry) => {
    const key =
      entry && typeof entry === 'object' && 'id' in entry
        ? `id:${String((entry as { id: unknown }).id)}`
        : JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizePath(p: string): string | null {
  const normalized = posix.normalize(p.trim().replace(/^\.?\//, ''));
  if (
    normalized.startsWith('..') ||
    normalized.startsWith('.') ||
    normalized.startsWith('assets/')
  ) {
    return null;
  }
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

/** Lines git writes around a conflict: `<<<<<<< label`, `=======`, `>>>>>>> label`. */
const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)|^={7}\s*$/m;

/** Whether a text still holds merge conflict markers. Such text never goes into the canon. */
export const hasConflictMarkers = (text: string) => CONFLICT_MARKER.test(text);

const addUnique = (list: string[], value: string) =>
  list.some((v) => v.toLowerCase() === value.toLowerCase()) ? list : [...list, value];

/**
 * Appends to or replaces the section under `heading` (matched case-insensitively at any level).
 * A missing section is added at the end as `## heading`.
 */
export function upsertSection(
  body: string,
  heading: string,
  text: string,
  mode: 'append' | 'replace',
): string {
  const lines = body.replace(/\s+$/, '').split('\n');
  const wanted = heading
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase();
  const start = lines.findIndex((line) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    return match?.[2]?.trim().toLowerCase() === wanted;
  });
  // Models often repeat the heading at the top of the text.
  const content = text
    .trim()
    .replace(
      new RegExp(`^#{1,6}\\s+${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\n+`, 'i'),
      '',
    )
    .trim();

  if (start === -1) {
    return `${lines.join('\n')}\n\n## ${heading.replace(/^#+\s*/, '').trim()}\n\n${content}\n`;
  }
  const level = /^(#+)/.exec(lines[start] ?? '')?.[1]?.length ?? 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^(#{1,6})\s/.exec(lines[i] ?? '');
    if (match && (match[1]?.length ?? 7) <= level) {
      end = i;
      break;
    }
  }
  const existing = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  const section = mode === 'replace' || !existing ? content : `${existing}\n\n${content}`;
  const before = lines.slice(0, start + 1);
  const after = lines.slice(end);
  return `${[...before, '', section, ...(after.length ? ['', ...after] : [])].join('\n')}\n`;
}
