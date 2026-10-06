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

/** The log view of a message: narration as prose, lines with the speaker's name. */
export function BeatsText({
  beats,
  names,
  userName,
}: {
  beats: Beat[];
  names: Map<string, string>;
  userName: string;
}) {
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
          const speaker = speakerName(beat.who, names, userName);
          return (
            <p key={key} className={styles.say}>
              <span className={speaker.known ? styles.name : styles.unknown}>{speaker.name}</span>
              {beat.mood && <span className={styles.mood}> ({beat.mood})</span>}:{' '}
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
