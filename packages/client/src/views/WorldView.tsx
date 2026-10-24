import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CanonFile, Commit, FileConflict, FileContent, FileWritten } from '@teahouse/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker, useParams, useSearchParams } from 'react-router';
import { api, download, RequestError } from '../api.ts';
import { Dialog } from '../components/Dialog.tsx';
import { ErrorText } from '../components/Field.tsx';
import { CharacterImages, WorldBackgrounds } from '../components/ImageManager.tsx';
import { CharacterRow, GroupChatStart } from '../components/StartChat.tsx';
import ui from '../components/ui.module.css';
import { useCharacters, useWorlds } from '../queries.ts';
import { clearDraft, clearDrafts, setDraft, useDirtyPaths, useDraft } from '../worldDrafts.ts';
import { DiffView } from './SceneParts.tsx';
import { ImportCard } from './WorldsView.tsx';
import styles from './WorldView.module.css';

const FOLDERS = ['characters', 'places', 'events', 'lore'] as const;
const TYPES: Record<string, string> = {
  characters: 'character',
  places: 'place',
  events: 'event',
  lore: 'lore',
};

function newFileTemplate(folder: string, name: string): string {
  const type = TYPES[folder] ?? 'lore';
  const lines = ['---', `type: ${type}`, `name: ${name}`, 'tags: []', 'aliases: []', 'summary: ""'];
  if (type === 'character') lines.push('greetings: []');
  return `${lines.join('\n')}\n---\n\n# ${name}\n\n`;
}

const fileSlug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'untitled';

export function WorldView() {
  const { worldId = '' } = useParams();
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const selected = search.get('file');
  const worlds = useWorlds();
  const world = worlds.data?.find((w) => w.id === worldId);
  const files = useQuery({
    queryKey: ['worlds', worldId, 'files'],
    queryFn: () => api.get<CanonFile[]>(`/api/worlds/${worldId}/files`),
  });

  const select = (path: string | null) => setSearch(path ? { file: path } : {});
  const dirty = useDirtyPaths(worldId);
  // Edits survive switching files; leaving the world or the page asks first.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty.length > 0 && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (dirty.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty.length]);
  const groups = [
    { name: '', files: files.data?.filter((f) => !f.path.includes('/')) ?? [] },
    ...FOLDERS.map((folder) => ({
      name: folder,
      files: files.data?.filter((f) => f.path.startsWith(`${folder}/`)) ?? [],
    })),
  ];

  return (
    <div className={styles.layout}>
      <nav className={styles.files} aria-label={t('worlds.files')}>
        <button
          className={styles.fileButton}
          type="button"
          aria-current={!selected}
          onClick={() => select(null)}
        >
          <strong>{world?.name ?? '…'}</strong>
        </button>
        {groups.map((group) => (
          <div key={group.name} className={styles.group}>
            {group.name && <h4>{group.name}</h4>}
            <ul className={styles.fileList}>
              {group.files.map((f) => (
                <li key={f.path}>
                  <button
                    className={styles.fileButton}
                    type="button"
                    aria-current={selected === f.path}
                    title={f.error ?? f.path}
                    onClick={() => select(f.path)}
                  >
                    {f.error && <span className={styles.warning}>⚠ </span>}
                    {group.name ? f.name : f.path}
                    {dirty.includes(f.path) && (
                      <span className={styles.dirty} title={t('worlds.unsaved')}>
                        {' ●'}
                        <span className={styles.visuallyHidden}>{t('worlds.unsaved')}</span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <NewFile worldId={worldId} onCreated={select} />
      </nav>
      <section className={styles.editor}>
        {selected ? (
          <>
            <FileEditor
              key={selected}
              worldId={worldId}
              path={selected}
              onDeleted={() => select(null)}
            />
            {/^characters\/[^/]+\.md$/.test(selected) && (
              <CharacterImages
                worldId={worldId}
                slug={selected.slice('characters/'.length, -'.md'.length)}
              />
            )}
          </>
        ) : (
          <Overview worldId={worldId} />
        )}
      </section>
      {blocker.state === 'blocked' && (
        <Dialog
          title={t('worlds.leaveTitle', { count: dirty.length })}
          onCancel={() => blocker.reset()}
          actions={
            <>
              <button className={ui.button} type="button" onClick={() => blocker.reset()}>
                {t('worlds.stay')}
              </button>
              <button
                className={ui.danger}
                type="button"
                onClick={() => {
                  clearDrafts(worldId);
                  blocker.proceed();
                }}
              >
                {t('worlds.leaveDiscard')}
              </button>
            </>
          }
        >
          <p>{t('worlds.leaveHint')}</p>
        </Dialog>
      )}
    </div>
  );
}

function Overview({ worldId }: { worldId: string }) {
  const { t } = useTranslation();
  const characters = useCharacters(worldId);
  const worlds = useWorlds();
  const exportWorld = useMutation({ mutationFn: () => download(`/api/worlds/${worldId}/export`) });
  return (
    <div>
      <div className={ui.actions}>
        <button
          className={ui.button}
          type="button"
          disabled={exportWorld.isPending}
          onClick={() => exportWorld.mutate()}
        >
          {t('worlds.export')}
        </button>
      </div>
      <ErrorText error={exportWorld.error} />
      <h3>{t('worlds.characters')}</h3>
      {characters.data?.length === 0 && <p className={ui.muted}>{t('worlds.noCharacters')}</p>}
      <ul className={ui.list}>
        {characters.data?.map((c) => (
          <CharacterRow key={c.slug} worldId={worldId} character={c} />
        ))}
      </ul>
      <GroupChatStart worldId={worldId} characters={characters.data ?? []} />
      <WorldBackgrounds worldId={worldId} />
      <ImportCard worlds={worlds.data ?? []} worldId={worldId} />
    </div>
  );
}

function NewFile({ worldId, onCreated }: { worldId: string; onCreated: (path: string) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [folder, setFolder] = useState<string>('characters');
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: async () => {
      const path = `${folder}/${fileSlug(name)}.md`;
      const existing = queryClient.getQueryData<CanonFile[]>(['worlds', worldId, 'files']);
      if (existing?.some((f) => f.path === path)) throw new Error(t('worlds.fileExists', { path }));
      await api.put(`/api/worlds/${worldId}/file`, {
        path,
        content: newFileTemplate(folder, name),
      });
      return path;
    },
    onSuccess: (path) => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['worlds', worldId] });
      onCreated(path);
    },
  });
  return (
    <form
      className={ui.form}
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <select
        className={ui.input}
        aria-label={t('worlds.folder')}
        value={folder}
        onChange={(e) => setFolder(e.target.value)}
      >
        {FOLDERS.map((f) => (
          <option key={f} value={f}>
            {f}/
          </option>
        ))}
      </select>
      <input
        className={ui.input}
        required
        placeholder={t('worlds.newFileName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button className={ui.button} type="submit" disabled={create.isPending}>
        {t('worlds.newFile')}
      </button>
      <ErrorText error={create.error} />
    </form>
  );
}

function FileEditor({
  worldId,
  path,
  onDeleted,
}: {
  worldId: string;
  path: string;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const encoded = encodeURIComponent(path);
  const file = useQuery({
    queryKey: ['worlds', worldId, 'file', path],
    queryFn: () => api.get<FileContent>(`/api/worlds/${worldId}/file?path=${encoded}`),
  });
  const history = useQuery({
    queryKey: ['worlds', worldId, 'history', path],
    queryFn: () => api.get<Commit[]>(`/api/worlds/${worldId}/history?path=${encoded}`),
  });
  const stored = useDraft(worldId, path);
  const [conflict, setConflict] = useState<FileConflict | null>(null);
  const [version, setVersion] = useState<Commit | null>(null);
  const old = useQuery({
    queryKey: ['worlds', worldId, 'file-at', path, version?.sha],
    queryFn: () =>
      api.get<FileContent>(`/api/worlds/${worldId}/file-at?path=${encoded}&sha=${version?.sha}`),
    enabled: Boolean(version),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['worlds', worldId] });
  const save = useMutation({
    mutationFn: (input: { content: string; baseSha: string | undefined }) =>
      api.put<FileWritten>(`/api/worlds/${worldId}/file`, { path, ...input }),
    onSuccess: (written, { content }) => {
      queryClient.setQueryData<FileContent>(['worlds', worldId, 'file', path], {
        path,
        content,
        sha: written.sha,
      });
      clearDraft(worldId, path);
      setConflict(null);
      setVersion(null);
      void invalidate();
    },
    onError: (err) => {
      if (err instanceof RequestError && err.code === 'file_conflict') {
        setConflict(err.data as FileConflict);
      }
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/worlds/${worldId}/file?path=${encoded}`),
    onSuccess: () => {
      void invalidate();
      onDeleted();
    },
  });

  if (file.error) return <ErrorText error={file.error} />;
  if (!file.data) return <p>{t('common.loading')}</p>;

  const current = file.data;
  // An edit stays against the content it started from, even when the file changes meanwhile.
  const draft = stored?.text ?? current.content;
  const dirty = stored !== undefined;
  const baseSha = stored ? stored.baseSha : current.sha;
  const edit = (text: string) =>
    setDraft(worldId, path, { text, base: stored?.base ?? current.content, baseSha });
  const discard = () => {
    clearDraft(worldId, path);
    setConflict(null);
  };
  const viewingOld = version !== null;

  return (
    <>
      <div className={styles.editorHeader}>
        <span className={styles.path}>{path}</span>
        {viewingOld ? (
          <>
            <span className={ui.muted}>
              {t('worlds.versionFrom', { date: new Date(version.date).toLocaleString() })}
            </span>
            <button className={ui.button} type="button" onClick={() => setVersion(null)}>
              {t('worlds.backToCurrent')}
            </button>
            <button
              className={ui.primary}
              type="button"
              disabled={!old.data || save.isPending}
              onClick={() =>
                old.data && save.mutate({ content: old.data.content, baseSha: current.sha })
              }
            >
              {t('worlds.restore')}
            </button>
          </>
        ) : (
          <>
            {path !== 'world.md' && (
              <button
                className={ui.ghost}
                type="button"
                onClick={() => {
                  if (window.confirm(t('common.confirmDelete', { name: path }))) remove.mutate();
                }}
              >
                {t('common.delete')}
              </button>
            )}
            <button className={ui.button} type="button" disabled={!dirty} onClick={discard}>
              {t('worlds.discard')}
            </button>
            <button
              className={ui.primary}
              type="button"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate({ content: draft, baseSha })}
            >
              {t('common.save')}
            </button>
          </>
        )}
      </div>
      {conflict ? (
        <div className={styles.conflict}>
          <strong>
            {conflict.current === null ? t('worlds.conflictDeleted') : t('worlds.conflictTitle')}
          </strong>
          <span className={ui.hint}>{t('worlds.conflictHint')}</span>
          <DiffView before={conflict.current ?? ''} after={draft} />
          <div className={ui.actions}>
            <button className={ui.button} type="button" onClick={discard}>
              {t('worlds.conflictDiscard')}
            </button>
            <button
              className={ui.primary}
              type="button"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({ content: draft, baseSha: conflict.currentSha ?? undefined })
              }
            >
              {t('worlds.conflictOverwrite')}
            </button>
          </div>
        </div>
      ) : (
        <ErrorText error={save.error ?? remove.error} />
      )}
      <textarea
        className={`${ui.input} ${styles.textarea}`}
        aria-label={path}
        spellCheck={!viewingOld}
        readOnly={viewingOld}
        value={viewingOld ? (old.data?.content ?? '') : draft}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            if (dirty && !viewingOld) save.mutate({ content: draft, baseSha });
          }
        }}
      />
      <div>
        <h4 style={{ margin: '0 0 4px' }}>{t('worlds.history')}</h4>
        <ul className={styles.history}>
          {history.data?.map((c, i) => (
            <li key={c.sha}>
              <span className={styles.sha}>{c.sha.slice(0, 7)}</span>
              <span className={ui.grow}>{c.message}</span>
              <span className={ui.muted}>{new Date(c.date).toLocaleString()}</span>
              <button
                className={ui.ghost}
                type="button"
                style={i === 0 ? { visibility: 'hidden' } : undefined}
                onClick={() => setVersion(c)}
              >
                {t('worlds.view')}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
