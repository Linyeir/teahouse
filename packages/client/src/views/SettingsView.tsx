import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Device, Profile, Settings } from '@teahouse/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, setToken } from '../api.ts';
import { ErrorText, Field } from '../components/Field.tsx';
import { PairDevice } from '../components/PairDevice.tsx';
import ui from '../components/ui.module.css';
import { languages } from '../i18n.ts';

export function SettingsView() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/api/settings'),
  });
  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/api/profiles'),
  });
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<Device[]>('/api/devices'),
  });
  const [draft, setDraft] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (next: Settings) => api.put<Settings>('/api/settings', next),
    onSuccess: (data) => queryClient.setQueryData(['settings'], data),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/devices/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['devices'] }),
  });
  const logout = useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSettled: () => {
      setToken(null);
      queryClient.clear();
    },
  });

  if (!draft) return <div className={ui.page}>{t('common.loading')}</div>;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(draft);
  };

  return (
    <div className={ui.page}>
      <h2 className={ui.title}>{t('nav.settings')}</h2>
      <form className={ui.form} onSubmit={onSubmit}>
        <div className={ui.row}>
          <Field label={t('settings.userName')}>
            <input
              className={ui.input}
              required
              value={draft.userName}
              onChange={(e) => setDraft({ ...draft, userName: e.target.value })}
            />
          </Field>
          <Field label={t('settings.outputLanguage')}>
            <input
              className={ui.input}
              required
              value={draft.outputLanguage}
              onChange={(e) => setDraft({ ...draft, outputLanguage: e.target.value })}
            />
          </Field>
        </div>
        <div className={ui.row}>
          {(
            [
              ['narratorProfileId', 'settings.narratorProfile', 'settings.firstProfile'],
              ['summaryProfileId', 'settings.summaryProfile', 'settings.sameAsNarrator'],
              ['canonProfileId', 'settings.canonProfile', 'settings.sameAsNarrator'],
              ['sceneProfileId', 'settings.sceneProfile', 'settings.sameAsNarrator'],
            ] as const
          ).map(([key, label, fallback]) => (
            <Field key={key} label={t(label)}>
              <select
                className={ui.input}
                value={draft[key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value || null })}
              >
                <option value="">{t(fallback)}</option>
                {profiles.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={draft.canonReview}
            onChange={(e) => setDraft({ ...draft, canonReview: e.target.checked })}
          />
          {t('settings.canonReview')}
        </label>
        <ErrorText error={save.error} />
        <div className={ui.actions}>
          {save.isSuccess && <span className={ui.muted}>{t('settings.saved')}</span>}
          <button className={ui.primary} type="submit" disabled={save.isPending}>
            {t('common.save')}
          </button>
        </div>
      </form>

      <h3>{t('settings.uiLanguage')}</h3>
      <select
        className={ui.input}
        value={i18n.resolvedLanguage}
        onChange={(e) => void i18n.changeLanguage(e.target.value)}
      >
        {Object.entries(languages).map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>

      <h3>{t('settings.devices')}</h3>
      <ul className={ui.list}>
        {devices.data?.map((d) => (
          <li key={d.id} className={ui.listItem}>
            <span className={ui.grow}>
              {d.name} {d.current && <span className={ui.muted}>({t('settings.thisDevice')})</span>}
            </span>
            {!d.current && (
              <button className={ui.ghost} type="button" onClick={() => revoke.mutate(d.id)}>
                {t('settings.revoke')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className={ui.actions} style={{ justifyContent: 'flex-start', marginBottom: 16 }}>
        <PairDevice devices={devices.data} />
      </div>
      <button className={ui.danger} type="button" onClick={() => logout.mutate()}>
        {t('auth.logout')}
      </button>
    </div>
  );
}
