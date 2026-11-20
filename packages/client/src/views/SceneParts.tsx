import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CanonProposal,
  type ChatPath,
  type MemoryNode,
  type ProposalFileView,
  type ProposalNote,
  sceneStage,
} from '@teahouse/shared';
import { diffLines } from 'diff';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { Dialog } from '../components/Dialog.tsx';
import { ErrorText, Field } from '../components/Field.tsx';
import ui from '../components/ui.module.css';
import { backgroundsQuery, useCharacters, useWorlds } from '../queries.ts';
import styles from './Scene.module.css';

export function MemoryMarker({ node }: { node: MemoryNode }) {
  const { t } = useTranslation();
  return (
    <details className={styles.memory}>
      <summary>{t('scenes.memoryUpToHere')}</summary>
      <p>{node.content}</p>
    </details>
  );
}

/** Asks how to end the scene, in a sheet over the stage: with a canon update or without. */
export function EndScene({ chatId, onDone }: { chatId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const close = useMutation({
    mutationFn: (withCanon: boolean) => api.post(`/api/chats/${chatId}/scene/close`, { withCanon }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
      onDone();
    },
  });
  return (
    <Dialog
      sheet
      title={t('scenes.endTitle')}
      onCancel={onDone}
      actions={
        <>
          <button className={ui.button} type="button" onClick={onDone}>
            {t('common.cancel')}
          </button>
          <button
            className={ui.button}
            type="button"
            disabled={close.isPending}
            onClick={() => close.mutate(false)}
          >
            {t('scenes.endWithoutCanon')}
          </button>
          <button
            className={ui.primary}
            type="button"
            disabled={close.isPending}
            onClick={() => close.mutate(true)}
          >
            {t('scenes.endWithCanon')}
          </button>
        </>
      }
    >
      <p className={ui.hint}>{t('scenes.endHint')}</p>
      <ErrorText error={close.error} />
    </Dialog>
  );
}

export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre className={styles.diff}>
      {parts.flatMap((part, i) => {
        const cls = part.added ? styles.add : part.removed ? styles.remove : styles.context;
        const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
        const lines = part.value.replace(/\n$/, '').split('\n');
        // Long unchanged stretches are cut to their edges.
        const shown =
          !part.added && !part.removed && lines.length > 6
            ? [...lines.slice(0, 2), '…', ...lines.slice(-2)]
            : lines;
        return shown.map((line, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity
          <span key={`${i}-${j}`} className={cls}>
            {prefix}
            {line}
          </span>
        ));
      })}
    </pre>
  );
}

/** Lines git writes around a conflict; such text is never accepted (the server checks too). */
const hasConflictMarkers = (text: string) => /^(<{7}|>{7})(\s|$)|^={7}\s*$/m.test(text);

/** A frontmatter value of a Markdown file, e.g. its `name` or `summary`, without quotes. */
function frontmatterValue(text: string, key: string): string | null {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim();
  return line ? line.replace(/^(['"])(.*)\1$/, '$2') : null;
}

/** One file of the proposal: what changes in words, its decision, the raw diff on request. */
function ProposalFileCard({ sceneId, file }: { sceneId: string; file: ProposalFileView }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (input: { decision: ProposalFileView['decision']; after?: string }) =>
      api.put<CanonProposal>(`/api/scenes/${sceneId}/proposal/file`, { path: file.path, ...input }),
    onSuccess: (proposal) => {
      queryClient.setQueryData(['proposal', sceneId], proposal);
      setDraft(null);
    },
  });
  const conflict = hasConflictMarkers(file.after);
  const draftConflict = draft !== null && hasConflictMarkers(draft);
  const name = frontmatterValue(file.after, 'name') ?? file.path;
  const badge =
    file.decision === 'accepted'
      ? styles.accepted
      : file.decision === 'rejected'
        ? styles.rejected
        : styles.badge;

  return (
    <div className={`${styles.file} ${conflict ? styles.conflictFile : ''}`}>
      <div className={styles.fileHeader}>
        <span className={styles.fileName}>{name}</span>
        <span className={styles.filePath}>{file.path}</span>
        <span className={styles.badge}>
          {file.before === null ? t('scenes.newFile') : t('scenes.changed')}
        </span>
        <span className={badge}>{t(`scenes.decision.${file.decision}`)}</span>
      </div>
      {conflict && <p className={styles.conflictText}>{t('scenes.conflictHint')}</p>}
      {(file.changes ?? []).length > 0 && (
        <ul className={styles.changes}>
          {(file.changes ?? []).map((change, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: changes have no identity of their own
            <li key={i}>
              {t(`scenes.change.${change.op}`, {
                detail: change.detail ?? '',
                defaultValue: change.op,
              })}
            </li>
          ))}
        </ul>
      )}
      {draft === null ? (
        <details className={styles.raw} open={conflict || undefined}>
          <summary className={styles.rawToggle}>{t('scenes.rawDiff')}</summary>
          <DiffView before={file.before ?? ''} after={file.after} />
        </details>
      ) : (
        <textarea
          className={`${ui.input} ${styles.editArea}`}
          aria-label={file.path}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      <div className={`${ui.actions} ${styles.fileActions}`}>
        {draft === null ? (
          <>
            <button className={ui.ghost} type="button" onClick={() => setDraft(file.after)}>
              {t('common.edit')}
            </button>
            <button
              className={ui.button}
              type="button"
              onClick={() => decide.mutate({ decision: 'rejected' })}
            >
              {t('scenes.reject')}
            </button>
            <button
              className={ui.primary}
              type="button"
              disabled={conflict}
              title={conflict ? t('scenes.resolveFirst') : undefined}
              onClick={() => decide.mutate({ decision: 'accepted' })}
            >
              {t('scenes.accept')}
            </button>
          </>
        ) : (
          <>
            <button className={ui.button} type="button" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </button>
            <button
              className={ui.primary}
              type="button"
              disabled={draftConflict}
              title={draftConflict ? t('scenes.resolveFirst') : undefined}
              onClick={() => decide.mutate({ decision: 'accepted', after: draft })}
            >
              {t('scenes.saveAndAccept')}
            </button>
          </>
        )}
      </div>
      <ErrorText error={decide.error} />
    </div>
  );
}

/** Changes the canon role proposed that were left out, softened, or are worth a second look. */
function ProposalNotes({ notes }: { notes: ProposalNote[] }) {
  const { t } = useTranslation();
  if (notes.length === 0) return null;
  return (
    <div className={styles.notes}>
      <strong>{t('scenes.notesTitle')}</strong>
      <ul>
        {notes.map((note, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: notes have no identity of their own
          <li key={i}>
            <span className={styles.filePath}>{note.path}</span>
            {note.detail && <> · „{note.detail}“</>}:{' '}
            {t(`scenes.note.${note.code}`, { defaultValue: note.reason })}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The top of the review: the scene as the world will remember it, and how much changes. */
function ProposalSummary({ files }: { files: ProposalFileView[] }) {
  const { t } = useTranslation();
  const event = files.find((f) => f.changes?.some((c) => c.op === 'event'));
  const created = files.filter((f) => f.before === null).length;
  return (
    <div className={`${ui.card} ${styles.summary}`}>
      {event && (
        <>
          <h3 className={styles.eventTitle}>
            {frontmatterValue(event.after, 'name') ?? event.path}
          </h3>
          {frontmatterValue(event.after, 'summary') && (
            <p>{frontmatterValue(event.after, 'summary')}</p>
          )}
        </>
      )}
      <span className={ui.hint}>
        {t('scenes.counts', {
          count: files.length,
          created,
          changed: files.length - created,
        })}
      </span>
    </div>
  );
}

/**
 * The canon proposal of a closing scene. It opens as a full-height sheet; "View scene" closes
 * it to read the scene again, and a card in the chat opens it once more.
 */
export function ProposalReview({ chatId, sceneId }: { chatId: string; sceneId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const proposal = useQuery({
    queryKey: ['proposal', sceneId],
    queryFn: () => api.get<CanonProposal | null>(`/api/scenes/${sceneId}/proposal`),
  });
  const apply = useMutation({
    mutationFn: () => api.post(`/api/scenes/${sceneId}/proposal/apply`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['proposal', sceneId] });
      void queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
    },
  });
  const regenerate = useMutation({
    mutationFn: () => api.post(`/api/scenes/${sceneId}/proposal/regenerate`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['proposal', sceneId] }),
  });
  const decideAll = useMutation({
    mutationFn: async (decision: 'accepted' | 'rejected') => {
      let last: CanonProposal | null = null;
      for (const file of proposal.data?.files ?? []) {
        // A conflict is only ever accepted by hand, after it is resolved.
        if (decision === 'accepted' && hasConflictMarkers(file.after)) continue;
        if (file.decision === decision) continue;
        last = await api.put<CanonProposal>(`/api/scenes/${sceneId}/proposal/file`, {
          path: file.path,
          decision,
        });
      }
      return last;
    },
    onSuccess: (last) => {
      if (last) queryClient.setQueryData(['proposal', sceneId], last);
    },
  });

  const data = proposal.data;
  if (!proposal.isSuccess) {
    return <p className={`${styles.panel} ${ui.muted}`}>{t('scenes.generating')}</p>;
  }
  // Still generating, or never started: a call that hangs, or a server stopped in the middle,
  // would otherwise leave the scene waiting for good.
  if (!data || data.status === 'generating') {
    return (
      <div className={styles.panel}>
        <span className={ui.muted}>{t('scenes.generating')}</span>
        <span className={ui.hint}>{t('scenes.generatingHint')}</span>
        <ErrorText error={regenerate.error} />
        <div className={ui.actions}>
          <button
            className={ui.button}
            type="button"
            disabled={regenerate.isPending}
            onClick={() => regenerate.mutate()}
          >
            {t('scenes.regenerate')}
          </button>
        </div>
      </div>
    );
  }
  const pending = data.files.filter((f) => f.decision === 'pending').length;
  const accepted = data.files.filter((f) => f.decision === 'accepted').length;

  return (
    <>
      <div className={`${ui.card} ${styles.panel}`}>
        <strong>{t('scenes.reviewTitle')}</strong>
        <span className={ui.hint}>{t('scenes.reviewWaiting')}</span>
        <div className={ui.actions}>
          <button className={ui.primary} type="button" onClick={() => setOpen(true)}>
            {t('scenes.openReview')}
          </button>
        </div>
      </div>
      {open && (
        <ReviewSheet title={t('scenes.reviewTitle')} onClose={() => setOpen(false)}>
          <div className={styles.sheetBody}>
            <ProposalSummary files={data.files} />
            <span className={ui.hint}>{t('scenes.reviewHint')}</span>
            {data.status === 'failed' && <p className={ui.error}>{data.error}</p>}
            <ProposalNotes notes={data.notes} />
            <div className={ui.actions}>
              <button
                className={ui.button}
                type="button"
                disabled={decideAll.isPending}
                onClick={() => decideAll.mutate('rejected')}
              >
                {t('scenes.rejectAll')}
              </button>
              <button
                className={ui.button}
                type="button"
                disabled={decideAll.isPending}
                onClick={() => decideAll.mutate('accepted')}
              >
                {t('scenes.acceptAll')}
              </button>
            </div>
            <ErrorText error={decideAll.error} />
            {data.files.map((file) => (
              <ProposalFileCard key={file.path} sceneId={sceneId} file={file} />
            ))}
          </div>
          <div className={styles.sheetFooter}>
            <ErrorText error={apply.error ?? regenerate.error} />
            {pending > 0 && (
              <span className={ui.hint}>{t('scenes.decideAll', { count: pending })}</span>
            )}
            <div className={ui.actions}>
              <button
                className={ui.button}
                type="button"
                disabled={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                {t('scenes.regenerate')}
              </button>
              <button
                className={ui.primary}
                type="button"
                disabled={data.status !== 'ready' || pending > 0 || apply.isPending}
                onClick={() => apply.mutate()}
              >
                {accepted > 0
                  ? t('scenes.apply', { count: accepted })
                  : t('scenes.closeWithoutChanges')}
              </button>
            </div>
          </div>
        </ReviewSheet>
      )}
    </>
  );
}

/** A modal sheet over the whole height: its own scrolling body and a footer that stays. */
function ReviewSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.sheet}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className={styles.sheetHeader}>
        <h2 id={titleId}>{title}</h2>
        <button className={ui.ghost} type="button" onClick={onClose}>
          {t('scenes.viewScene')}
        </button>
      </div>
      {children}
    </dialog>
  );
}

/** Sets up the next scene: a brief, an opening proposed by the LLM, and the cast. */
export function NewScene({ path }: { path: ChatPath }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const characters = useCharacters(path.chat.worldId);
  const [brief, setBrief] = useState('');
  const [startMessage, setStartMessage] = useState('');
  const [cast, setCast] = useState<string[]>(path.scene?.cast ?? []);
  const backgrounds = useQuery(backgroundsQuery(path.chat.worldId));
  const world = useWorlds().data?.find((w) => w.id === path.chat.worldId);
  // Where the last scene ended, else the world's default.
  const lastBackground =
    sceneStage(path.messages, path.scene?.cast ?? []).background ?? world?.defaultBackground ?? '';
  const [background, setBackground] = useState<string | null>(null);
  const chosenBackground = background ?? lastBackground;

  const propose = useMutation({
    mutationFn: () =>
      api.post<{ startMessage: string; cast: string[] }>(
        `/api/chats/${path.chat.id}/scene/propose`,
        { brief },
      ),
    onSuccess: (result) => {
      setStartMessage(result.startMessage);
      setCast(result.cast);
    },
  });
  const start = useMutation({
    mutationFn: () =>
      api.post<ChatPath>(`/api/chats/${path.chat.id}/scenes`, {
        // The opening sets the background, so the stage and the narrator both know it.
        startMessage:
          chosenBackground && !/<bg\b/i.test(startMessage)
            ? `<bg id="${chosenBackground}"/>\n${startMessage}`
            : startMessage,
        cast,
      }),
    onSuccess: (data) => queryClient.setQueryData(['chat', path.chat.id], data),
  });

  return (
    <div className={`${ui.card} ${styles.panel}`}>
      <h3 className={styles.sceneTitle}>
        {t('scenes.nextTitle', { n: (path.scene?.number ?? 0) + 1 })}
      </h3>
      <Field label={t('scenes.brief')} hint={t('scenes.briefHint')}>
        <textarea
          className={ui.input}
          rows={3}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
      </Field>
      <div className={ui.actions}>
        <button
          className={ui.button}
          type="button"
          disabled={propose.isPending}
          onClick={() => propose.mutate()}
        >
          {propose.isPending ? t('scenes.proposing') : t('scenes.propose')}
        </button>
      </div>
      <ErrorText error={propose.error} />
      <Field label={t('scenes.startMessage')}>
        <textarea
          className={ui.input}
          rows={6}
          value={startMessage}
          onChange={(e) => setStartMessage(e.target.value)}
        />
      </Field>
      {(backgrounds.data?.length ?? 0) > 0 && (
        <Field label={t('scenes.background')}>
          <select
            className={ui.input}
            value={chosenBackground}
            onChange={(e) => setBackground(e.target.value)}
          >
            <option value="">{t('scenes.noBackground')}</option>
            {backgrounds.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.description || b.id}
              </option>
            ))}
          </select>
        </Field>
      )}
      <fieldset className={styles.cast} style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className={ui.hint}>{t('scenes.cast')}</legend>
        {characters.data?.map((c) => (
          <label key={c.slug}>
            <input
              type="checkbox"
              checked={cast.includes(c.slug)}
              onChange={(e) =>
                setCast(e.target.checked ? [...cast, c.slug] : cast.filter((s) => s !== c.slug))
              }
            />
            {c.name}
          </label>
        ))}
      </fieldset>
      <ErrorText error={start.error} />
      <div className={ui.actions}>
        <button
          className={ui.primary}
          type="button"
          disabled={cast.length === 0 || start.isPending}
          onClick={() => start.mutate()}
        >
          {t('scenes.start')}
        </button>
      </div>
    </div>
  );
}
