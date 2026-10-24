import {
  type CharacterSummary,
  type PathMessage,
  USER_SPEAKER,
  type WorldBackground,
} from '@teahouse/shared';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assetUrl } from '../api.ts';
import { formatStory, speakerName } from '../components/Beats.tsx';
import { type VnPage, vnPages } from '../vn.ts';
import styles from './VnStage.module.css';

/** The image for a character in a mood: that label (in any case), else neutral, else the first. */
function spriteFor(character: CharacterSummary | undefined, mood: string | null) {
  const images = character?.images ?? [];
  const wanted = mood?.trim().toLowerCase();
  return (
    images.find((i) => i.label.toLowerCase() === wanted) ??
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
  const slugs = new Map(
    characters.flatMap((c) => [
      [c.name.toLowerCase(), c.slug],
      [c.slug.toLowerCase(), c.slug],
    ]),
  );
  const pages = vnPages(
    messages,
    cast,
    new Set(backgrounds.map((b) => b.id)),
    (who) => slugs.get(who.trim().toLowerCase()) ?? null,
  );

  // null follows the newest message (also while it streams in).
  const [cursor, setCursor] = useState<number | null>(null);
  const position = Math.min(cursor ?? pages.length - 1, pages.length - 1);
  const atEnd = position >= pages.length - 1;
  const page = pages[position];
  const streaming = page?.message.status === 'streaming' && atEnd;

  const go = (delta: number) => {
    const next = Math.max(0, Math.min(pages.length - 1, position + delta));
    setCursor(next >= pages.length - 1 ? null : next);
  };

  // A long reply scrolls in its textbox: reading on scrolls first, then turns the page.
  const textbox = useRef<HTMLButtonElement>(null);
  const advance = () => {
    const el = textbox.current;
    if (el && el.scrollTop + el.clientHeight < el.scrollHeight - 4) {
      el.scrollBy({ top: el.clientHeight * 0.8, behavior: 'smooth' });
    } else {
      go(1);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('textarea, input, select, [contenteditable]')) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        advance();
      } else if (e.key === 'ArrowRight') {
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

  const pageId = page?.message.id;
  const length = page?.message.content.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page starts at its top
  useEffect(() => {
    if (textbox.current) textbox.current.scrollTop = 0;
  }, [pageId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow a reply as it streams in
  useEffect(() => {
    const el = textbox.current;
    if (el && streaming) el.scrollTop = el.scrollHeight;
  }, [length, streaming]);

  const stage = page?.stage;
  const background = backgrounds.find((b) => b.id === stage?.background);
  const names = new Map(characters.map((c) => [c.slug, c.name]));
  const themeStyle = Object.fromEntries(
    Object.entries(theme).map(([k, v]) => [`--${k}`, v]),
  ) as CSSProperties;

  const speaker = page?.speaker ? speakerName(page.speaker, names, userName) : null;
  // The character whose turn it is stands out; on the narrator's or the user's turn, nobody.
  const focus = page?.speaker && page.speaker !== USER_SPEAKER ? page.speaker : null;

  return (
    <div className={styles.stage} style={themeStyle}>
      {background && (
        <img className={styles.background} src={assetUrl(worldId, background.file)} alt="" />
      )}
      <div className={styles.sprites}>
        {(stage?.present ?? cast.map((who) => ({ who, mood: null }))).map((p) => {
          const character = characters.find((c) => c.slug === p.who);
          const sprite = spriteFor(character, p.mood);
          const dim = focus !== null && focus !== p.who;
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
        <button
          type="button"
          ref={textbox}
          className={styles.textbox}
          onClick={advance}
          aria-live="polite"
        >
          {page ? (
            <PageText page={page} names={names} userName={userName} streaming={streaming} />
          ) : (
            <span className={`${styles.text} ${styles.empty}`}>{t('vn.empty')}</span>
          )}
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
          {pages.length ? position + 1 : 0}/{pages.length}
        </span>
        <button type="button" onClick={() => go(1)} disabled={atEnd} aria-label={t('vn.next')}>
          ›
        </button>
      </div>
    </div>
  );
}

/**
 * A whole message as one passage: narration in italics, speech plain. Lines of someone other
 * than the name above the box (older replies with several speakers) carry their name.
 */
function PageText({
  page,
  names,
  userName,
  streaming,
}: {
  page: VnPage;
  names: Map<string, string>;
  userName: string;
  streaming: boolean;
}) {
  const last = page.beats.length - 1;
  return (
    <span className={styles.text}>
      {page.beats.map((beat, i) => {
        const cursor = streaming && i === last ? styles.cursor : '';
        const key = `${i}-${beat.type}`;
        if (beat.type === 'narration') {
          return (
            <span key={key} className={`${styles.line} ${styles.narration} ${cursor}`}>
              {formatStory(beat.text)}
            </span>
          );
        }
        const other = beat.who === page.speaker ? null : speakerName(beat.who, names, userName);
        return (
          <span
            key={key}
            className={`${styles.line} ${beat.who === USER_SPEAKER ? styles.user : ''} ${cursor}`}
          >
            {other && (
              <span className={`${styles.lineName} ${other.known ? '' : styles.unknown}`}>
                {other.name}:{' '}
              </span>
            )}
            {formatStory(beat.text)}
          </span>
        );
      })}
      {page.beats.length === 0 && streaming && (
        <span className={`${styles.line} ${styles.cursor}`} />
      )}
    </span>
  );
}
