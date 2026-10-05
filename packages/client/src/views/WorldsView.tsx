import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CardImportResult, World } from '@teahouse/shared';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api } from '../api.ts';
import { ErrorText, Field } from '../components/Field.tsx';
import ui from '../components/ui.module.css';
import { useWorlds } from '../queries.ts';

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
      <CreateWorld />
      <ImportCard worlds={worlds.data ?? []} />
    </div>
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

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      if (target) form.append('worldId', target);
      if (file) form.append('file', file);
      return api.upload<CardImportResult>('/api/import/card', form);
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['worlds'] });
      navigate(`/worlds/${result.worldId}`);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    upload.mutate();
  };

  return (
    <form
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
