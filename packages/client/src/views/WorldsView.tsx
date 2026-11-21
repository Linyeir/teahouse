import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardImportResult, InstalledWorld, SampleWorld, World } from '@teahouse/shared';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api } from '../api.ts';
import { themeName } from '../components/AppearanceSettings.tsx';
import { ErrorText, Field } from '../components/Field.tsx';
import { useStartChat } from '../components/StartChat.tsx';
import ui from '../components/ui.module.css';
import { useCustomThemes } from '../customThemes.ts';
import { pushToast } from '../notices.ts';
import { charactersQuery, useWorlds } from '../queries.ts';

export function WorldsView() {
  const { t } = useTranslation();
  const worlds = useWorlds();

  return (
    <div className={ui.page}>
      <h2 className={ui.title}>{t('nav.worlds')}</h2>
      {worlds.data?.length === 0 && <p className={ui.muted}>{t('worlds.empty')}</p>}
      <ul className={ui.list}>
        {worlds.data?.map((w) => (
          <li key={w.id} className={ui.listItem}>
            <div className={ui.grow}>
              <Link to={`/worlds/${w.id}`}>{w.name}</Link>
              {w.summary && <div className={ui.hint}>{w.summary}</div>}
            </div>
            <span className={ui.hint}>{w.folder}/</span>
          </li>
        ))}
      </ul>
      <SampleWorlds />
      <CreateWorld />
      <ImportCard worlds={worlds.data ?? []} />
      <ImportWorld />
    </div>
  );
}

/** Ready-made worlds with characters, images and a theme, to try Teahouse without a card. */
function SampleWorlds() {
  const { t } = useTranslation();
  const customThemes = useCustomThemes();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const samples = useQuery({
    queryKey: ['samples'],
    queryFn: () => api.get<SampleWorld[]>('/api/samples'),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const load = useMutation({
    mutationFn: (id: string) => api.post<InstalledWorld>(`/api/samples/${id}`),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['worlds'] });
      navigate(`/worlds/${result.worldId}`);
    },
  });
  if (!samples.data?.length) return null;
  return (
    <section className={`${ui.card} ${ui.form}`} style={{ marginBottom: 'var(--space)' }}>
      <h3 style={{ margin: 0 }}>{t('worlds.samples')}</h3>
      <p className={ui.hint} style={{ margin: 0 }}>
        {t('worlds.samplesHint')}
      </p>
      <ul className={ui.list} style={{ margin: 0 }}>
        {samples.data.map((s) => (
          <li key={s.id} className={ui.listItem}>
            <div className={ui.grow}>
              <strong>{s.name}</strong>
              {s.themePreset && (
                <span className={ui.badge}>{themeName(t, s.themePreset, customThemes)}</span>
              )}
              <div className={ui.hint}>{s.summary}</div>
            </div>
            <button
              className={ui.button}
              type="button"
              disabled={load.isPending}
              onClick={() => load.mutate(s.id)}
            >
              {load.isPending && load.variables === s.id
                ? t('worlds.loadingSample')
                : t('worlds.loadSample')}
            </button>
          </li>
        ))}
      </ul>
      <ErrorText error={load.error} />
    </section>
  );
}

function CreateWorld() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<World>('/api/worlds', { name }),
    onSuccess: (world) => {
      void queryClient.invalidateQueries({ queryKey: ['worlds'] });
      navigate(`/worlds/${world.id}`);
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form className={`${ui.card} ${ui.form}`} onSubmit={onSubmit}>
      <h3 style={{ margin: 0 }}>{t('worlds.new')}</h3>
      <div className={ui.row}>
        <Field label={t('worlds.name')}>
          <input
            className={ui.input}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
          <button className={ui.primary} type="submit" disabled={create.isPending}>
            {t('common.create')}
          </button>
        </div>
      </div>
      <ErrorText error={create.error} />
    </form>
  );
}

const NEW_WORLD = '';

export function ImportCard({ worlds, worldId }: { worlds: World[]; worldId?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState(worldId ?? NEW_WORLD);
  // A new key empties the file input after an import.
  const [formKey, setFormKey] = useState(0);
  const startChat = useStartChat();

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      if (target) form.append('worldId', target);
      if (file) form.append('file', file);
      return api.upload<CardImportResult>('/api/import/card', form);
    },
    onSuccess: async (result) => {
      void queryClient.invalidateQueries({ queryKey: ['worlds'] });
      if (!target) {
        navigate(`/worlds/${result.worldId}`);
        return;
      }
      // Into a world that exists: the form starts over, and a toast offers the new character.
      setFile(null);
      setFormKey((k) => k + 1);
      const world = worlds.find((w) => w.id === result.worldId)?.name ?? '';
      const characters = await queryClient
        .fetchQuery({ ...charactersQuery(result.worldId), staleTime: 0 })
        .catch(() => []);
      const name =
        characters.find((c) => c.slug === result.characterSlug)?.name ?? result.characterSlug;
      pushToast(t('worlds.imported', { name, world }), {
        action: {
          label: t('worlds.startChat'),
          onClick: () =>
            startChat.mutate({
              worldId: result.worldId,
              characterSlug: result.characterSlug,
              greetingIndex: 0,
            }),
        },
      });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    upload.mutate();
  };

  return (
    <form
      key={formKey}
      className={`${ui.card} ${ui.form}`}
      onSubmit={onSubmit}
      style={{ marginTop: 'var(--space)' }}
    >
      <h3 style={{ margin: 0 }}>{t('worlds.importCard')}</h3>
      <p className={ui.hint} style={{ margin: 0 }}>
        {t('worlds.importHint')}
      </p>
      <div className={ui.row}>
        <Field label={t('worlds.cardFile')}>
          <input
            className={ui.input}
            type="file"
            accept=".png,.json,image/png,application/json"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label={t('worlds.target')}>
          <select className={ui.input} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value={NEW_WORLD}>{t('worlds.newWorldFromCard')}</option>
            {worlds.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorText error={upload.error} />
      <div className={ui.actions}>
        <button className={ui.primary} type="submit" disabled={!file || upload.isPending}>
          {t('worlds.import')}
        </button>
      </div>
    </form>
  );
}

function ImportWorld() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      if (file) form.append('file', file);
      return api.upload<{ worldId: string; copy: boolean }>('/api/import/world', form);
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['worlds'] });
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      navigate(`/worlds/${result.worldId}`);
    },
  });
  return (
    <form
      className={`${ui.card} ${ui.form}`}
      style={{ marginTop: 'var(--space)' }}
      onSubmit={(e) => {
        e.preventDefault();
        upload.mutate();
      }}
    >
      <h3 style={{ margin: 0 }}>{t('worlds.importWorld')}</h3>
      <p className={ui.hint} style={{ margin: 0 }}>
        {t('worlds.importWorldHint')}
      </p>
      <Field label={t('worlds.archiveFile')}>
        <input
          className={ui.input}
          type="file"
          accept=".gz,.tgz,application/gzip"
          required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <ErrorText error={upload.error} />
      <div className={ui.actions}>
        <button className={ui.primary} type="submit" disabled={!file || upload.isPending}>
          {t('worlds.import')}
        </button>
      </div>
    </form>
  );
}
