import {
  type Beat,
  type CharacterSummary,
  type PathMessage,
  stageAfter,
  USER_SPEAKER,
  type WorldBackground,
} from '@teahouse/shared';
import { type CSSProperties, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assetUrl } from '../api.ts';
import { formatStory, messageBeats, speakerName } from '../components/Beats.tsx';
import styles from './VnStage.module.css';

interface Entry {
  beat: Beat;
  message: PathMessage;
}

/** The image for a character in a mood: that label, else neutral, else any. */
function spriteFor(character: CharacterSummary | undefined, mood: string | null) {
  const images = character?.images ?? [];
  return (
    images.find((i) => i.label === mood) ??
    images.find((i) => i.label === 'neutral') ??
    images[0] ??
    null
  );
}

export function VnStage({
  worldId,
  messages,
  cast,
  characters,
  backgrounds,
  theme,
  userName,
}: {
  worldId: string;
  messages: PathMessage[];
  cast: string[];
  characters: CharacterSummary[];
  backgrounds: WorldBackground[];
  theme: Record<string, string>;
  userName: string;
}) {
  const { t } = useTranslation();
  const known = new Set(backgrounds.map((b) => b.id));
  // An unknown background keeps the current one (concept, section 6).
  const entries: Entry[] = messages.flatMap((message) =>
    messageBeats(message)
      .filter((beat) => beat.type !== 'bg' || known.has(beat.id))
      .map((beat) => ({ beat, message })),
  );
  const shown = entries
    .map((entry, index) => ({ ...entry, index }))
    .filter((e) => e.beat.type === 'narration' || e.beat.type === 'say');

  // null follows the newest beat (also while it streams in).
  const [cursor, setCursor] = useState<number | null>(null);
  const position = Math.min(cursor ?? shown.length - 1, shown.length - 1);
  const atEnd = position >= shown.length - 1;
  const current = shown[position];

  const go = (delta: number) => {
    const next = Math.max(0, Math.min(shown.length - 1, position + delta));
    setCursor(next >= shown.length - 1 ? null : next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('textarea, input, select, [contenteditable]')) return;
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const stage = stageAfter(
    entries.slice(0, (current?.index ?? -1) + 1).map((e) => e.beat),
    { background: null, present: cast.map((who) => ({ who, mood: null })), speaker: null },
  );
  const background = backgrounds.find((b) => b.id === stage.background);
  const names = new Map(characters.map((c) => [c.slug, c.name]));
  const themeStyle = Object.fromEntries(
    Object.entries(theme).map(([k, v]) => [`--${k}`, v]),
  ) as CSSProperties;

  const beat = current?.beat;
  const speaker = beat?.type === 'say' ? speakerName(beat.who, names, userName) : null;
  const streaming = current?.message.status === 'streaming' && atEnd;

  return (
    <div className={styles.stage} style={themeStyle}>
      {background && (
        <img className={styles.background} src={assetUrl(worldId, background.file)} alt="" />
      )}
      <div className={styles.sprites}>
        {stage.present.map((p) => {
          const character = characters.find((c) => c.slug === p.who);
          const sprite = spriteFor(character, p.mood);
          const dim = stage.speaker !== null && stage.speaker !== p.who;
          return (
            <div key={p.who} className={`${styles.sprite} ${dim ? styles.dim : ''}`}>
              {sprite ? (
                <img src={assetUrl(worldId, sprite.file)} alt={character?.name ?? p.who} />
              ) : (
                <div className={styles.placeholder} title={character?.name ?? p.who}>
                  {(character?.name ?? p.who).slice(0, 1)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.textboxFrame}>
        {speaker && (
          <span className={`${styles.name} ${speaker.known ? '' : styles.unknown}`}>
            {speaker.name}
          </span>
        )}
        <button type="button" className={styles.textbox} onClick={() => go(1)} aria-live="polite">
          <span
            className={`${styles.text} ${beat?.type === 'narration' ? styles.narration : ''} ${beat?.type === 'say' && beat.who === USER_SPEAKER ? styles.user : ''} ${streaming ? styles.cursor : ''}`}
          >
            {beat && (beat.type === 'narration' || beat.type === 'say') ? (
              formatStory(beat.text)
            ) : (
              <span className={styles.empty}>{t('vn.empty')}</span>
            )}
          </span>
        </button>
      </div>
      <div className={styles.controls}>
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={position <= 0}
          aria-label={t('vn.back')}
        >
          ‹
        </button>
        <span>
          {shown.length ? position + 1 : 0}/{shown.length}
        </span>
        <button type="button" onClick={() => go(1)} disabled={atEnd} aria-label={t('vn.next')}>
          ›
        </button>
      </div>
    </div>
  );
}
