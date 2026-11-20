import {
  type Beat,
  NARRATOR_SPEAKER,
  type PathMessage,
  parseUserInput,
  type StageState,
  stageAfter,
  stageBeats,
  USER_SPEAKER,
} from '@teahouse/shared';

/** A line of text in the textbox: narration, or what someone says. */
export type TextBeat = Extract<Beat, { type: 'narration' | 'say' }>;

/** One message in the novel view: its whole text in one textbox. */
export interface VnPage {
  message: PathMessage;
  beats: TextBeat[];
  /**
   * Whose name the textbox shows: a character slug, `USER_SPEAKER`, or null for the narrator
   * and for older replies in which several characters speak.
   */
  speaker: string | null;
  /** The stage after the whole message: background, who is present, their last mood. */
  stage: StageState;
}

const isText = (beat: Beat): beat is TextBeat => beat.type === 'narration' || beat.type === 'say';

const MARKUP = /<\/?(narration|say|bg|leave)\b/i;
const QUOTED = /("[^"\n]+"|“[^”\n]+”)/;

/**
 * A card greeting has no tags, so it is split the way cards write it: `*action*` is
 * narration. With quotes, quoted text is the opener's speech and the rest narration; without,
 * all unmarked text is speech, as in user input.
 */
export function greetingBeats(text: string, opener: string): TextBeat[] {
  const quoted = QUOTED.test(text);
  const beats: TextBeat[] = [];
  const push = (type: 'narration' | 'say', content: string) => {
    const clean = content.trim();
    if (!clean) return;
    const last = beats.at(-1);
    if (last?.type === type) last.text = `${last.text} ${clean}`;
    else if (type === 'say')
      beats.push({ type, who: opener, mood: null, text: clean, complete: true });
    else beats.push({ type, text: clean, complete: true });
  };
  for (const part of text.split(/(\*[^*]+\*)/g)) {
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      push('narration', part.slice(1, -1));
    } else if (!quoted) {
      push('say', part);
    } else {
      for (const piece of part.split(QUOTED)) {
        const isQuote = QUOTED.test(piece) && piece.length > 2;
        push(isQuote ? 'say' : 'narration', isQuote ? piece.slice(1, -1) : piece);
      }
    }
  }
  return beats;
}

function pageSpeaker(message: PathMessage, beats: TextBeat[]): string | null {
  if (message.role === 'user') return USER_SPEAKER;
  if (message.speaker === NARRATOR_SPEAKER) return null;
  if (message.speaker) return message.speaker;
  // Replies from before turns had a speaker: name them after their only speaker, if any.
  const speakers = new Set(beats.flatMap((b) => (b.type === 'say' ? [b.who] : [])));
  return speakers.size === 1 ? ([...speakers][0] ?? null) : null;
}

/**
 * The pages of the novel view, one per message with text. A reply that is still streaming
 * gets a page before its first words arrive. An unknown background keeps the current one
 * (concept, section 6).
 */
export function vnPages(
  messages: PathMessage[],
  cast: string[],
  backgrounds: Set<string>,
  options: {
    /** The card greeting that opened the chat, and whose it is. */
    greeting?: { messageId: string; opener: string };
    /** The background before the narrator picks one. */
    background?: string | null;
  } = {},
): VnPage[] {
  const { greeting } = options;
  let stage: StageState = {
    background: options.background ?? null,
    present: cast.map((who) => ({ who, mood: null })),
    speaker: null,
  };
  const pages: VnPage[] = [];
  for (const message of messages) {
    const isGreeting =
      greeting?.messageId === message.id && !message.speaker && !MARKUP.test(message.content);
    const all: Beat[] =
      message.role === 'user'
        ? parseUserInput(message.content)
        : isGreeting
          ? greetingBeats(message.content, greeting?.opener ?? '')
          : stageBeats(message, { final: message.status !== 'streaming' });
    stage = stageAfter(
      all.filter((b) => b.type !== 'bg' || backgrounds.has(b.id)),
      stage,
    );
    const beats = all.filter(isText);
    if (beats.length === 0 && message.status !== 'streaming') continue;
    const speaker = isGreeting ? (greeting?.opener ?? null) : pageSpeaker(message, beats);
    pages.push({ message, beats, speaker, stage });
  }
  return pages;
}
