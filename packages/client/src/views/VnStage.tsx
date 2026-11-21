import {
  type CharacterSummary,
  type PathMessage,
  type StageState,
  USER_SPEAKER,
  type WorldBackground,
} from '@teahouse/shared';
import { type CSSProperties, type MouseEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assetUrl } from '../api.ts';
import { formatStory, speakerName } from '../components/Beats.tsx';
import ui from '../components/ui.module.css';
import { NAME_TEXT, namePreset } from '../nameColors.ts';
import { stageKeyAction, type VnPage, vnPages } from '../vn.ts';
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
  scenes,
  greeting,
  characters,
  backgrounds,
  defaultBackground,
  theme,
  userName,
  tools,
  picked,
  onPickSpeaker,
}: {
  worldId: string;
  /** Every scene of the chat in order, the current one last. Closed scenes are read-only. */
  scenes: StageScene[];
  greeting?: { messageId: string; opener: string };
  characters: CharacterSummary[];
  backgrounds: WorldBackground[];
  defaultBackground: string | null;
  theme: Record<string, string>;
  userName: string;
  /** Swipe, regenerate and edit for the page being read; absent when the scene is over. */
  tools?: StageTools;
  /** Who takes the next turn, highlighted on stage. */
  picked?: string;
  /** Tapping a sprite picks who takes the next turn. */
  onPickSpeaker?: (slug: string) => void;
}) {
  const { t } = useTranslation();
  const slugs = new Map(
    characters.flatMap((c) => [
      [c.name.toLowerCase(), c.slug],
      [c.slug.toLowerCase(), c.slug],
    ]),
  );
  // Until the narrator picks one: the world's default background, else its first.
  const startBackground =
    backgrounds.find((b) => b.id === defaultBackground)?.id ?? backgrounds[0]?.id ?? null;
  const known = new Set(backgrounds.map((b) => b.id));
  // Each scene opens with a title card, then a page per message.
  const pages: StagePage[] = scenes.flatMap((scene) => {
    const messagePages = vnPages(scene.messages, scene.cast, known, {
      greeting,
      background: startBackground,
      resolve: (who) => slugs.get(who.trim().toLowerCase()) ?? null,
    });
    const opening: StageState = messagePages[0]?.stage ?? {
      background: startBackground,
      present: scene.cast.map((who) => ({ who, mood: null })),
      speaker: null,
    };
    return [
      { scene: scene.number, readOnly: scene.readOnly, page: null, stage: opening },
      ...messagePages.map((page) => ({
        scene: scene.number,
        readOnly: scene.readOnly,
        page,
        stage: page.stage,
      })),
    ];
  });
  const current = scenes.at(-1);
  const messages = current?.messages ?? [];
  const cast = current?.cast ?? [];

  // null follows the newest message (also while it streams in).
  const [cursor, setCursor] = useState<number | null>(null);
  const position = Math.min(cursor ?? pages.length - 1, pages.length - 1);
  const atEnd = position >= pages.length - 1;
  const entry = pages[position];
  const page = entry?.page ?? undefined;
  const streaming = page?.message.status === 'streaming' && atEnd;

  // A scene that just started opens on its title card.
  const sceneNumber = current?.number ?? 0;
  const seenScene = useRef(sceneNumber);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when a new scene begins
  useEffect(() => {
    if (sceneNumber > seenScene.current) {
      const title = pages.findIndex((p) => p.scene === sceneNumber && p.page === null);
      if (title >= 0) setCursor(title >= pages.length - 1 ? null : title);
    }
    seenScene.current = sceneNumber;
  }, [sceneNumber]);

  const go = (delta: number) => {
    const next = Math.max(0, Math.min(pages.length - 1, position + delta));
    setCursor(next >= pages.length - 1 ? null : next);
  };

  // A long reply scrolls in its textbox: reading on scrolls first, then turns the page.
  const textbox = useRef<HTMLDivElement>(null);
  const textboxButton = useRef<HTMLButtonElement>(null);
  const hasMore = () => {
    const el = textbox.current;
    return !!el && el.scrollTop + el.clientHeight < el.scrollHeight - 4;
  };
  const advance = () => {
    const el = textbox.current;
    if (el && hasMore()) {
      el.scrollBy({ top: el.clientHeight * 0.8, behavior: 'smooth' });
    } else {
      go(1);
    }
  };

  // Editing the message on the page, in place of the textbox.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // The stage's own controls and any other control keep their keys; the textbox and
      // the stage itself page.
      const focus =
        !target || target === document.body
          ? 'none'
          : target === textboxButton.current ||
              (stageRef.current?.contains(target) &&
                !target.closest('button, a, input, textarea, select'))
            ? 'stage'
            : 'other';
      const action = stageKeyAction(e.key, focus, e.ctrlKey || e.metaKey || e.altKey);
      if (!action) return;
      e.preventDefault();
      if (action === 'advance') advance();
      else go(action === 'next' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // On touch, the whole stage is the page: the left third goes back, the rest reads on.
  const pointer = useRef<string>('mouse');
  const onStageClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (
      pointer.current !== 'touch' ||
      editing ||
      target.closest(`.${styles.controls}, .${styles.sprite} button`)
    ) {
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    if (e.clientX < box.left + box.width / 3) go(-1);
    else advance();
  };

  const pageId = page?.message.id;
  const length = page?.message.content.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new or finished page starts at its top
  useEffect(() => {
    if (textbox.current && !streaming) textbox.current.scrollTop = 0;
  }, [pageId, streaming]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow a reply as it streams in
  useEffect(() => {
    const el = textbox.current;
    if (el && streaming) el.scrollTop = el.scrollHeight;
  }, [length, streaming]);

  // Whether text is hidden below the fold: shown as ▼, else ▶ when a next page exists.
  const [overflow, setOverflow] = useState(false);
  const measure = () => setOverflow(hasMore());
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useEffect(() => {
    measure();
    const el = textbox.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pageId, length, streaming]);
  const cue = streaming ? null : overflow ? '▼' : atEnd ? null : '▶';

  const stage = entry?.stage;
  const background = backgrounds.find((b) => b.id === (stage?.background ?? startBackground));
  const names = new Map(characters.map((c) => [c.slug, c.name]));
  const themeStyle = Object.fromEntries(
    Object.entries(theme).map(([k, v]) => [`--${k}`, v]),
  ) as CSSProperties;

  const speaker = page?.speaker ? speakerName(page.speaker, names, userName) : null;
  // The character whose turn it is stands out; on the narrator's or the user's turn, nobody.
  const focus = page?.speaker && page.speaker !== USER_SPEAKER ? page.speaker : null;
  const present = stage?.present ?? cast.map((who) => ({ who, mood: null }));
  // A world that sets its own badge color keeps it for everyone without `color:`.
  const badge = page?.speaker
    ? nameBadge(page.speaker, characters, 'vn-name-bg' in theme)
    : undefined;
  // Screen readers hear a page once it is complete, not every streamed word.
  const announcement = page && !streaming ? pageAnnouncement(page, names, userName) : '';

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the window, see above */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a tap zone for touch; the textbox and controls are the accessible way */}
      <div
        ref={stageRef}
        className={styles.stage}
        style={themeStyle}
        onPointerDown={(e) => {
          pointer.current = e.pointerType;
        }}
        onClick={onStageClick}
      >
        {background && (
          <img className={styles.background} src={assetUrl(worldId, background.file)} alt="" />
        )}
        <div className={`${styles.sprites} ${present.length >= 4 ? styles.crowd : ''}`}>
          {present.map((p) => {
            const character = characters.find((c) => c.slug === p.who);
            const sprite = spriteFor(character, p.mood);
            const dim = focus !== null && focus !== p.who;
            const name = character?.name ?? p.who;
            const image = sprite ? (
              <img src={assetUrl(worldId, sprite.file)} alt={onPickSpeaker ? '' : name} />
            ) : (
              <div className={styles.placeholder} title={name}>
                {name.slice(0, 1)}
              </div>
            );
            const classes = [
              styles.sprite,
              dim ? styles.dim : '',
              focus === p.who ? styles.speaking : '',
              picked === p.who ? styles.picked : '',
            ].join(' ');
            return (
              <div key={p.who} className={classes}>
                {onPickSpeaker ? (
                  // The speaker chips above the text field are the keyboard way to pick.
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t('vn.pickSpeaker', { name })}
                    onClick={() => onPickSpeaker(p.who)}
                  >
                    {image}
                  </button>
                ) : (
                  image
                )}
              </div>
            );
          })}
        </div>
        {entry && !entry.page ? (
          // A scene's first page: its number over the opening stage.
          <button
            type="button"
            ref={textboxButton}
            className={styles.titleCard}
            onClick={() => pointer.current !== 'touch' && go(1)}
          >
            <span>{t('scenes.title', { n: entry.scene })}</span>
          </button>
        ) : (
          <div className={styles.textboxFrame}>
            {speaker && (
              <span
                className={`${styles.name} ${speaker.known ? '' : styles.unknown} ${
                  page?.speaker === USER_SPEAKER ? styles.userName : ''
                }`}
                style={badge}
              >
                {speaker.name}
              </span>
            )}
            {editing ? (
              <form
                className={styles.editor}
                onSubmit={(e) => {
                  e.preventDefault();
                  const message = messages.find((m) => m.id === editing.id);
                  if (message && tools) tools.onEdit(message, editing.text);
                  setEditing(null);
                }}
              >
                <textarea
                  aria-label={t('common.edit')}
                  value={editing.text}
                  onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  // biome-ignore lint/a11y/noAutofocus: the user just asked to edit this text
                  autoFocus
                />
                <div className={styles.editorActions}>
                  <button className={ui.button} type="button" onClick={() => setEditing(null)}>
                    {t('common.cancel')}
                  </button>
                  <button className={ui.primary} type="submit">
                    {t('common.save')}
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                ref={textboxButton}
                className={styles.textbox}
                // Touch taps are the stage's (see onStageClick); a click or a key reads on.
                onClick={() => pointer.current !== 'touch' && advance()}
              >
                <div ref={textbox} className={styles.scroll} onScroll={measure}>
                  {page ? (
                    <PageText page={page} names={names} userName={userName} streaming={streaming} />
                  ) : (
                    <span className={`${styles.text} ${styles.empty}`}>{t('vn.empty')}</span>
                  )}
                </div>
                {cue && (
                  <span className={styles.cue} aria-hidden="true">
                    {cue}
                  </span>
                )}
              </button>
            )}
          </div>
        )}
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
        <span className={styles.srOnly} aria-live="polite">
          {announcement}
        </span>
      </div>
      {tools && page && !entry?.readOnly && !streaming && !editing && (
        <PageTools
          message={page.message}
          last={atEnd}
          tools={tools}
          onEdit={() => setEditing({ id: page.message.id, text: tools.editText(page.message.id) })}
        />
      )}
    </>
  );
}

/** A scene as the stage shows it. */
export interface StageScene {
  number: number;
  cast: string[];
  messages: PathMessage[];
  readOnly: boolean;
}

/** A page of the stage: a scene's title card (`page` null) or one of its messages. */
interface StagePage {
  scene: number;
  readOnly: boolean;
  page: VnPage | null;
  stage: StageState;
}

export interface StageTools {
  online: boolean;
  canRegenerate: (message: PathMessage) => boolean;
  onSelect: (id: string) => void;
  onRegenerate: (message: PathMessage) => void;
  /** The stored text of a message (placeholders unfilled), to edit. */
  editText: (id: string) => string;
  onEdit: (message: PathMessage, content: string) => void;
  /** Ends the path at this message, so the next one starts a new branch. */
  onBranch: (message: PathMessage) => void;
}

/**
 * Tools for the message on the page. On the last page: its versions and regenerate. On an
 * earlier page only edit, because a new version there would drop everything after it.
 */
function PageTools({
  message,
  last,
  tools,
  onEdit,
}: {
  message: PathMessage;
  last: boolean;
  tools: StageTools;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const index = message.siblingIds.indexOf(message.id);
  const count = message.siblingIds.length;
  const regenerate = last && message.role === 'assistant' && tools.canRegenerate(message);
  const needsServer = last && (count > 1 || regenerate);
  return (
    <div className={styles.tools}>
      {last && count > 1 && (
        <>
          <button
            className={ui.ghost}
            type="button"
            disabled={index <= 0 || !tools.online}
            aria-label={t('chats.previousVersion')}
            onClick={() => tools.onSelect(message.siblingIds[index - 1] ?? message.id)}
          >
            ‹
          </button>
          <span>
            {index + 1}/{count}
          </span>
          <button
            className={ui.ghost}
            type="button"
            disabled={index >= count - 1 || !tools.online}
            aria-label={t('chats.nextVersion')}
            onClick={() => tools.onSelect(message.siblingIds[index + 1] ?? message.id)}
          >
            ›
          </button>
        </>
      )}
      {regenerate && (
        <button
          className={ui.ghost}
          type="button"
          disabled={!tools.online}
          aria-label={t('chats.regenerate')}
          title={t('chats.regenerate')}
          onClick={() => tools.onRegenerate(message)}
        >
          ⟳
        </button>
      )}
      {needsServer && !tools.online && <span className={ui.hint}>{t('vn.needsServer')}</span>}
      <div className={styles.menu}>
        <button
          className={ui.ghost}
          type="button"
          aria-label={t('vn.more')}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          ⋯
        </button>
        {menu && (
          <div className={styles.menuList} role="menu">
            <button
              type="button"
              role="menuitem"
              // biome-ignore lint/a11y/noAutofocus: focus moves into the menu that just opened
              autoFocus
              onClick={() => {
                setMenu(false);
                onEdit();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMenu(false);
              }}
            >
              {t('common.edit')}
            </button>
            {!last && (
              <button
                type="button"
                role="menuitem"
                disabled={!tools.online}
                onClick={() => {
                  setMenu(false);
                  tools.onBranch(message);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setMenu(false);
                }}
              >
                {t('chats.branch')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Badge colors: the character's `color:`, else a preset picked by slug, per theme. */
function nameBadge(
  speaker: string,
  characters: CharacterSummary[],
  themed: boolean,
): CSSProperties | undefined {
  if (speaker === USER_SPEAKER) return undefined;
  const color = characters.find((c) => c.slug === speaker)?.color;
  if (color) return { '--name-light': color, '--name-dark': color } as CSSProperties;
  if (themed) return undefined;
  const preset = namePreset(speaker);
  return {
    '--name-light': preset.light,
    '--name-dark': preset.dark,
    '--name-text-light': NAME_TEXT.light,
    '--name-text-dark': NAME_TEXT.dark,
  } as CSSProperties;
}

/** A page as one sentence for screen readers: who speaks, then the text. */
function pageAnnouncement(page: VnPage, names: Map<string, string>, userName: string): string {
  const lines = page.beats.map((beat) =>
    beat.type === 'say'
      ? `${speakerName(beat.who, names, userName).name}: ${beat.text}`
      : beat.text,
  );
  return lines.join('\n');
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
