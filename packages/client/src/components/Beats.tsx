import { type Beat, parseMarkup, parseUserInput, USER_SPEAKER } from '@teahouse/shared';
import type { ReactNode } from 'react';
import styles from './Beats.module.css';

/** Renders `*action*` spans in italics. */
export function formatStory(text: string): ReactNode[] {
  return text.split(/(\*[^*\n]+\*)/g).map((part, i) =>
    part.length > 2 && part.startsWith('*') && part.endsWith('*') ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity beyond position
      <em key={i}>{part.slice(1, -1)}</em>
    ) : (
      part
    ),
  );
}

export function messageBeats(message: { role: string; content: string; status: string }): Beat[] {
  return message.role === 'user'
    ? parseUserInput(message.content)
    : parseMarkup(message.content, { final: message.status !== 'streaming' });
}

/** Display name for a beat's speaker; unknown slugs show as written and are flagged. */
export function speakerName(
  who: string,
  names: Map<string, string>,
  userName: string,
): { name: string; known: boolean } {
  if (who === USER_SPEAKER) return { name: userName, known: true };
  const name = names.get(who);
  return name ? { name, known: true } : { name: who || '?', known: false };
}

/** Each character's last mood before each message, for `BeatsText`. */
export function moodsBefore(
  messages: { id: string; role: string; content: string; status: string }[],
): Map<string, ReadonlyMap<string, string>> {
  const result = new Map<string, ReadonlyMap<string, string>>();
  let moods = new Map<string, string>();
  for (const message of messages) {
    result.set(message.id, moods);
    const next = new Map(moods);
    for (const beat of messageBeats(message)) {
      if (beat.type === 'say' && beat.mood) next.set(beat.who, beat.mood);
    }
    moods = next;
  }
  return result;
}

/**
 * The log view of a message: narration as prose, lines with the speaker's name. The name is
 * left out on lines of the message's own speaker, whose name already stands above it, as in
 * the novel view. A mood shows only when it changes: `moods` holds each character's last mood
 * before this message (see `moodsBefore`).
 */
export function BeatsText({
  beats,
  names,
  userName,
  speaker = null,
  moods = new Map(),
}: {
  beats: Beat[];
  names: Map<string, string>;
  userName: string;
  /** Whose turn the message is: a character slug, or null. */
  speaker?: string | null;
  moods?: ReadonlyMap<string, string>;
}) {
  const last = new Map(moods);
  return (
    <>
      {beats.map((beat, i) => {
        const key = `${i}-${beat.type}`;
        if (beat.type === 'narration') {
          return (
            <p key={key} className={styles.narration}>
              {formatStory(beat.text)}
            </p>
          );
        }
        if (beat.type === 'say') {
          const who = speakerName(beat.who, names, userName);
          const mood = beat.mood && beat.mood !== last.get(beat.who) ? beat.mood : null;
          if (beat.mood) last.set(beat.who, beat.mood);
          const named = beat.who !== speaker;
          return (
            <p key={key} className={styles.say}>
              {named && (
                <>
                  <span className={who.known ? styles.name : styles.unknown}>{who.name}</span>
                  {': '}
                </>
              )}
              {mood && <span className={styles.mood}>{mood}</span>}
              {formatStory(beat.text)}
            </p>
          );
        }
        const label =
          beat.type === 'bg' ? `⟶ ${beat.id}` : `${speakerName(beat.who, names, userName).name} ⟶`;
        return (
          <p key={key} className={styles.stage}>
            {label}
          </p>
        );
      })}
    </>
  );
}
