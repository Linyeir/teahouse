/**
 * Tag markup of narrator replies (concept, section 6):
 *
 *   <bg id="tavern-night"/>
 *   <narration>Rain drums against the windows.</narration>
 *   <say who="mira" mood="amused">So you came after all.</say>
 *   <leave who="tomas"/>
 *
 * The parser is lenient, because models get the format wrong: text outside tags is
 * narration, unclosed tags end at the end of the text, a new <say> or <narration> closes the
 * open one, unknown tags are kept as text and reasoning blocks (<think>) are dropped.
 * It re-parses the whole text on every call, which is cheap at message size and makes
 * streaming trivial.
 */

export type Beat =
  | { type: 'narration'; text: string; complete: boolean }
  | { type: 'say'; who: string; mood: string | null; text: string; complete: boolean }
  | { type: 'bg'; id: string }
  | { type: 'leave'; who: string };

/** `who` of beats spoken by the user's persona (from `*action* speech` input). */
export const USER_SPEAKER = '@user';

const TAG = /<(\/?)(narration|say|bg|leave)\b([^<>]*?)(\/?)>/gi;
const ATTR = /([a-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/gi;

function attributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(ATTR)) {
    attrs[(m[1] ?? '').toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return attrs;
}

/** Removes reasoning blocks and, while streaming, a tag that is still being written. */
function clean(text: string, final: boolean): string {
  let out = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  if (!final) out = out.replace(/<\/?[a-z]*(\s[^<>]*)?$/i, '');
  return out;
}

export function parseMarkup(text: string, options: { final?: boolean } = {}): Beat[] {
  const final = options.final ?? true;
  const source = clean(text, final);
  const beats: Beat[] = [];
  let open: { type: 'narration' } | { type: 'say'; who: string; mood: string | null } | null = null;
  let buffer = '';

  const flush = (complete: boolean) => {
    const content = buffer.trim();
    buffer = '';
    if (open?.type === 'say') {
      // An empty line still counts: the character "speaks" (e.g. a silent mood change).
      beats.push({ type: 'say', who: open.who, mood: open.mood, text: content, complete });
    } else if (content) {
      const last = beats.at(-1);
      // Untagged text next to narration belongs to it.
      if (last?.type === 'narration' && !open && last.complete) {
        last.text = `${last.text}\n\n${content}`;
      } else {
        beats.push({ type: 'narration', text: content, complete });
      }
    }
  };

  let index = 0;
  for (const match of source.matchAll(TAG)) {
    buffer += source.slice(index, match.index);
    index = (match.index ?? 0) + match[0].length;
    const closing = match[1] === '/';
    const name = (match[2] ?? '').toLowerCase();
    const attrs = attributes(match[3] ?? '');
    const selfClosing = match[4] === '/' || name === 'bg' || name === 'leave';

    if (closing) {
      // Closing tags only end what is open; stray ones are dropped.
      if (open && open.type === name) {
        flush(true);
        open = null;
      }
      continue;
    }
    if (selfClosing) {
      if (name === 'bg' && attrs.id) {
        flush(true);
        open = null;
        beats.push({ type: 'bg', id: attrs.id });
      } else if (name === 'leave' && attrs.who) {
        flush(true);
        open = null;
        beats.push({ type: 'leave', who: attrs.who });
      }
      continue;
    }
    flush(true);
    open =
      name === 'say'
        ? { type: 'say', who: attrs.who ?? '', mood: attrs.mood || null }
        : { type: 'narration' };
  }
  buffer += source.slice(index);
  flush(final);
  return beats;
}

/**
 * Turns user input into beats: `*asterisks*` mark action (narration), the rest is the
 * persona's speech (concept, section 6).
 */
export function parseUserInput(text: string): Beat[] {
  const beats: Beat[] = [];
  for (const part of text.split(/(\*[^*]+\*)/g)) {
    const isAction = part.length > 2 && part.startsWith('*') && part.endsWith('*');
    const content = (isAction ? part.slice(1, -1) : part).trim();
    if (!content) continue;
    beats.push(
      isAction
        ? { type: 'narration', text: content, complete: true }
        : { type: 'say', who: USER_SPEAKER, mood: null, text: content, complete: true },
    );
  }
  return beats;
}

/**
 * Index of the first `<say>` for the user's persona, if the model starts speaking for them.
 * `names` are the persona's name and aliases (compared case-insensitively).
 */
export function findUserLine(text: string, names: string[]): number | null {
  const wanted = new Set(['user', '{{user}}', USER_SPEAKER, ...names].map((n) => n.toLowerCase()));
  for (const match of text.matchAll(TAG)) {
    if (match[1] === '/' || (match[2] ?? '').toLowerCase() !== 'say') continue;
    const who = attributes(match[3] ?? '').who?.toLowerCase();
    if (who && wanted.has(who)) return match.index ?? null;
  }
  return null;
}

/** What the stage shows after a sequence of beats: background and who is present. */
export interface StageState {
  background: string | null;
  /** Present characters in order of appearance, with their latest mood. */
  present: { who: string; mood: string | null }[];
  /** Who spoke last; the VN view highlights them. */
  speaker: string | null;
}

export function stageAfter(beats: Beat[], initial?: StageState): StageState {
  const state: StageState = {
    background: initial?.background ?? null,
    present: initial?.present.map((p) => ({ ...p })) ?? [],
    speaker: null,
  };
  for (const beat of beats) {
    if (beat.type === 'bg') state.background = beat.id;
    else if (beat.type === 'leave') {
      state.present = state.present.filter((p) => p.who !== beat.who);
      if (state.speaker === beat.who) state.speaker = null;
    } else if (beat.type === 'say' && beat.who !== USER_SPEAKER) {
      // A character enters implicitly with their first line.
      const existing = state.present.find((p) => p.who === beat.who);
      if (existing) existing.mood = beat.mood ?? existing.mood;
      else state.present.push({ who: beat.who, mood: beat.mood });
      state.speaker = beat.who;
    } else if (beat.type === 'narration') {
      state.speaker = null;
    }
  }
  return state;
}

/**
 * Plain text of a reply for summaries and canon updates: narration as prose, lines as
 * `Name: text`. `names` maps character slugs to display names.
 */
export function markupToText(text: string, names: Map<string, string> = new Map()): string {
  return parseMarkup(text)
    .flatMap((beat) => {
      if (beat.type === 'narration') return [beat.text];
      if (beat.type === 'say') return [`${names.get(beat.who) ?? beat.who}: ${beat.text}`];
      if (beat.type === 'leave') return [`(${names.get(beat.who) ?? beat.who} leaves.)`];
      return [];
    })
    .join('\n');
}
