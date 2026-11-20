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
  | { type: 'leave'; who: string }
  /** Not in the markup: a character's turn brings them on stage (see `stageBeats`). */
  | { type: 'enter'; who: string };

/** `who` of beats spoken by the user's persona (from `*action* speech` input). */
export const USER_SPEAKER = '@user';

/** `speaker` of a reply written by the narrator rather than by one character. */
export const NARRATOR_SPEAKER = '@narrator';

const TAG = /<(\/?)(narration|say|bg|leave)\b([^<>]*?)(\/?)>/gi;
const ATTR = /([a-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/gi;

function attributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(ATTR)) {
    attrs[(m[1] ?? '').toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return attrs;
}

const REASONING = /<(think|thinking)>[\s\S]*?(<\/\1>|$)/gi;
const REASONING_END = /<\/(?:think|thinking)>/gi;

/**
 * Removes the reasoning of reasoning models: `<think>` and `<thinking>` blocks, and everything
 * before a closing tag whose opening one is missing (some servers cut it off, so the
 * reasoning arrives as plain text that ends in `</think>`).
 */
export function stripReasoning(text: string): string {
  const out = text.replace(REASONING, '');
  const orphan = [...out.matchAll(REASONING_END)].at(-1);
  return orphan ? out.slice((orphan.index ?? 0) + orphan[0].length) : out;
}

/** Removes reasoning and, while streaming, a tag that is still being written. */
function clean(text: string, final: boolean): string {
  let out = stripReasoning(text);
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

/** Index of the first `<say>` whose speaker `foreign` rejects, e.g. when the model speaks for someone else. */
export function findForeignLine(text: string, foreign: (who: string) => boolean): number | null {
  for (const match of text.matchAll(TAG)) {
    if (match[1] === '/' || (match[2] ?? '').toLowerCase() !== 'say') continue;
    const who = attributes(match[3] ?? '').who;
    if (who && foreign(who)) return match.index ?? null;
  }
  return null;
}

const WHO = /(\bwho\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/i;

/**
 * Rewrites `who` of `<say>` and `<leave>` to what `resolve` returns, e.g. a character's name,
 * alias or a differently cased slug to the slug. Unresolved speakers stay as they are.
 */
export function normalizeSpeakers(text: string, resolve: (who: string) => string | null): string {
  return text.replace(TAG, (tag, closing: string, name: string) => {
    if (closing || !/^(say|leave)$/i.test(name)) return tag;
    return tag.replace(WHO, (attr, prefix: string, a?: string, b?: string, c?: string) => {
      const who = (a ?? b ?? c ?? '').trim();
      const slug = resolve(who);
      return slug && slug !== who ? `${prefix}"${slug}"` : attr;
    });
  });
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
    else if (beat.type === 'enter') {
      if (!state.present.some((p) => p.who === beat.who)) {
        state.present.push({ who: beat.who, mood: null });
      }
    } else if (beat.type === 'leave') {
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

/** A message as far as the stage is concerned: its markup, after its speaker enters. */
export interface StageMessage {
  role: 'user' | 'assistant';
  content: string;
  speaker: string | null;
}

/**
 * Beats of a reply for the stage. A character whose turn it is enters before their reply, so
 * they appear even when they only act and say nothing.
 */
export function stageBeats(message: StageMessage, options: { final?: boolean } = {}): Beat[] {
  const beats = parseMarkup(message.content, options);
  const speaker = message.speaker;
  return speaker && speaker !== NARRATOR_SPEAKER
    ? [{ type: 'enter', who: speaker }, ...beats]
    : beats;
}

/** The stage after a scene's replies, starting with the cast present. */
export function sceneStage(messages: StageMessage[], cast: string[]): StageState {
  return stageAfter(
    messages.filter((m) => m.role === 'assistant').flatMap((m) => stageBeats(m)),
    { background: null, present: cast.map((who) => ({ who, mood: null })), speaker: null },
  );
}

/**
 * Who takes the next turn unless the user picks someone: the character whose turn was last,
 * else the first of the cast, else the narrator.
 */
export function defaultSpeaker(messages: StageMessage[], cast: string[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const speaker = messages[i]?.speaker;
    if (speaker && speaker !== NARRATOR_SPEAKER) return speaker;
  }
  return cast[0] ?? NARRATOR_SPEAKER;
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
