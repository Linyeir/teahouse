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
): VnPage[] {
  let stage: StageState = {
    background: null,
    present: cast.map((who) => ({ who, mood: null })),
    speaker: null,
  };
  const pages: VnPage[] = [];
  for (const message of messages) {
    const all =
      message.role === 'user'
        ? parseUserInput(message.content)
        : stageBeats(message, { final: message.status !== 'streaming' });
    stage = stageAfter(
      all.filter((b) => b.type !== 'bg' || backgrounds.has(b.id)),
      stage,
    );
    const beats = all.filter(isText);
    if (beats.length === 0 && message.status !== 'streaming') continue;
    pages.push({ message, beats, speaker: pageSpeaker(message, beats), stage });
  }
  return pages;
}
