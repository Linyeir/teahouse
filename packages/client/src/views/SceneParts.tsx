import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CanonProposal, ChatPath, MemoryNode, ProposalFileView } from '@teahouse/shared';
import { diffLines } from 'diff';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { ErrorText, Field } from '../components/Field.tsx';
import ui from '../components/ui.module.css';
import { useCharacters } from '../queries.ts';
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

/** Asks how to end the scene: with a canon update or without. */
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
    <div className={`${ui.card} ${styles.panel}`}>
      <strong>{t('scenes.endTitle')}</strong>
      <span className={ui.hint}>{t('scenes.endHint')}</span>
      <ErrorText error={close.error} />
      <div className={ui.actions}>
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
      </div>
    </div>
  );
}

function DiffView({ before, after }: { before: string; after: string }) {
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
  const conflict = file.after.includes('<<<<<<< current');
  const badge =
    file.decision === 'accepted'
      ? styles.accepted
      : file.decision === 'rejected'
        ? styles.rejected
        : styles.badge;

  return (
    <div className={styles.file}>
      <div className={styles.fileHeader}>
        <span className={styles.filePath}>{file.path}</span>
        <span className={styles.badge}>
          {file.before === null ? t('scenes.newFile') : t('scenes.changed')}
        </span>
        {conflict && <span className={styles.rejected}>{t('scenes.conflict')}</span>}
        <span className={badge}>{t(`scenes.decision.${file.decision}`)}</span>
      </div>
      {draft === null ? (
        <DiffView before={file.before ?? ''} after={file.after} />
      ) : (
        <textarea
          className={`${ui.input} ${styles.editArea}`}
          aria-label={file.path}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      <div className={ui.actions} style={{ padding: 8 }}>
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

/** Per-file review of the canon proposal of a closing scene. */
export function ProposalReview({ chatId, sceneId }: { chatId: string; sceneId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
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

  const data = proposal.data;
  if (!data || data.status === 'generating') {
    return <p className={`${styles.panel} ${ui.muted}`}>{t('scenes.generating')}</p>;
  }
  const pending = data.files.filter((f) => f.decision === 'pending').length;
  const accepted = data.files.filter((f) => f.decision === 'accepted').length;

  return (
    <div className={styles.panel}>
      <strong>{t('scenes.reviewTitle')}</strong>
      <span className={ui.hint}>{t('scenes.reviewHint')}</span>
      {data.status === 'failed' && <p className={ui.error}>{data.error}</p>}
      {data.files.map((file) => (
        <ProposalFileCard key={file.path} sceneId={sceneId} file={file} />
      ))}
      <ErrorText error={apply.error ?? regenerate.error} />
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
          title={pending > 0 ? t('scenes.decideAll') : undefined}
          onClick={() => apply.mutate()}
        >
          {accepted > 0 ? t('scenes.apply', { count: accepted }) : t('scenes.closeWithoutChanges')}
        </button>
      </div>
    </div>
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
      api.post<ChatPath>(`/api/chats/${path.chat.id}/scenes`, { startMessage, cast }),
    onSuccess: (data) => queryClient.setQueryData(['chat', path.chat.id], data),
  });

  return (
    <div className={`${ui.card} ${styles.panel}`}>
      <strong>{t('scenes.nextTitle', { n: (path.scene?.number ?? 0) + 1 })}</strong>
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
