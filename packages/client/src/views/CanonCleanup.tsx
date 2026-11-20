import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CanonProposal } from '@teahouse/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { ErrorText } from '../components/Field.tsx';
import ui from '../components/ui.module.css';
import styles from './Scene.module.css';
import { ProposalSheet, type ProposalTarget } from './SceneParts.tsx';

/**
 * The cleanup run over a whole world, on its overview: it refreshes summaries, finds
 * contradictions and duplicates, and suggests new files, aliases and tags. Its proposal is
 * reviewed like a scene's, but never holds up a scene.
 */
export function CanonCleanup({ worldId }: { worldId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const target: ProposalTarget = {
    base: `/api/worlds/${worldId}/cleanup`,
    queryKey: ['cleanup', worldId],
  };
  const proposal = useQuery({
    queryKey: target.queryKey,
    queryFn: () => api.get<CanonProposal | null>(target.base),
  });
  const start = useMutation({
    mutationFn: () => api.post<CanonProposal>(target.base),
    onSuccess: (data) => queryClient.setQueryData(target.queryKey, data),
  });
  const apply = useMutation({
    mutationFn: () => api.post(`${target.base}/apply`),
    onSuccess: () => setOpen(false),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: target.queryKey });
      // Files may be new, merged away or renamed by alias; chats may have a new character.
      void queryClient.invalidateQueries({ queryKey: ['worlds', worldId] });
      void queryClient.invalidateQueries({ queryKey: ['chat'] });
    },
  });

  const data = proposal.data;
  const status = data?.status;
  const files = data?.files ?? [];
  const startButton = (label: string) => (
    <button
      className={ui.button}
      type="button"
      disabled={start.isPending}
      onClick={() => start.mutate()}
    >
      {label}
    </button>
  );

  return (
    <div className={`${ui.card} ${styles.panel}`}>
      <strong>{t('cleanup.title')}</strong>
      <span className={ui.hint}>{t('cleanup.hint')}</span>
      {status === 'generating' ? (
        <>
          <span className={ui.muted}>{t('cleanup.generating')}</span>
          <div className={ui.actions}>{startButton(t('cleanup.restart'))}</div>
        </>
      ) : status === 'failed' ? (
        <>
          <p className={ui.error}>{data?.error}</p>
          <div className={ui.actions}>{startButton(t('cleanup.restart'))}</div>
        </>
      ) : status === 'ready' && files.length > 0 ? (
        <>
          <span>{t('cleanup.waiting', { count: files.length })}</span>
          <div className={ui.actions}>
            <button className={ui.primary} type="button" onClick={() => setOpen(true)}>
              {t('cleanup.review')}
            </button>
          </div>
        </>
      ) : (
        <>
          {status === 'ready' && <span className={ui.muted}>{t('cleanup.nothingFound')}</span>}
          <div className={ui.actions}>{startButton(t('cleanup.start'))}</div>
        </>
      )}
      <ErrorText error={start.error ?? proposal.error} />
      {open && data && status === 'ready' && (
        <ProposalSheet
          title={t('cleanup.title')}
          closeLabel={t('common.dismiss')}
          onClose={() => setOpen(false)}
          target={target}
          data={data}
          summary={<CleanupSummary data={data} />}
          apply={apply}
          regenerate={start}
          emptyApplyLabel={t('cleanup.applyNothing')}
        />
      )}
    </div>
  );
}

/** How much the cleanup changes: fixed contradictions, merges, new and changed files. */
function CleanupSummary({ data }: { data: CanonProposal }) {
  const { t } = useTranslation();
  const changes = data.files.flatMap((f) => f.changes);
  return (
    <div className={`${ui.card} ${styles.summary}`}>
      <span>
        {t('cleanup.counts', {
          contradictions: changes.filter((c) => c.op === 'fix_contradiction').length,
          merges: changes.filter((c) => c.op === 'merge').length,
          created: data.files.filter((f) => f.before === null).length,
          changed: data.files.filter((f) => f.before !== null && f.after !== null).length,
        })}
      </span>
    </div>
  );
}
