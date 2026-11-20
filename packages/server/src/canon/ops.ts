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
export type CanonOp = z.infer<typeof canonOp>;

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
  | 'alias_not_in_scene';

export interface OpNote {
  op: CanonOp;
  /** What happened, for the review to put into words. */
  code: NoteCode;
  /** `skipped`: left out. `downgraded`: applied in a safer form. `flagged`: applied, but worth a look. */
  outcome: 'skipped' | 'downgraded' | 'flagged';
  reason: string;
}

export interface ApplyResult {
  /** Path → new content, only for files that changed. */
  files: Map<string, string>;
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
  const files = new Map<string, string>();
  const notes: OpNote[] = [];
  const skip = (op: CanonOp, code: NoteCode, reason: string) =>
    notes.push({ op, code, outcome: 'skipped', reason });
  const get = (p: string) => files.get(p) ?? current.get(p);
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
    if (op.op === 'set_summary' && unseen(target)) {
      skip(op, 'unseen_summary', 'the file was not read in full, so its summary stays');
      continue;
    }
    const downgrade = op.op === 'replace_section' && unseen(target);
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
