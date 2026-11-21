import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Device, type Profile, type Settings, TEAHOUSE_VERSION } from '@teahouse/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, setToken } from '../api.ts';
import { AppearanceSettings } from '../components/AppearanceSettings.tsx';
import { ConnectionSettings } from '../components/ConnectionSettings.tsx';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { ErrorText, Field } from '../components/Field.tsx';
import { PairDevice } from '../components/PairDevice.tsx';
import ui from '../components/ui.module.css';
import { languages } from '../i18n.ts';
import { useServerVersion } from '../version.ts';

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
  const serverVersion = useServerVersion();
  const [draft, setDraft] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data) setDraft((d) => d ?? settings.data);
  }, [settings.data]);

  // Every setting saves as soon as it changes; the field shows "Saved" for a moment.
  const [saved, setSaved] = useState<keyof Settings | null>(null);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), 2500);
    return () => clearTimeout(timer);
  }, [saved]);
  const save = useMutation({
    mutationFn: (next: Settings) => api.put<Settings>('/api/settings', next),
    onSuccess: (data) => queryClient.setQueryData(['settings'], data),
  });
  const commit = (next: Settings, field: keyof Settings) => {
    setDraft(next);
    save.mutate(next, { onSuccess: () => setSaved(field) });
  };
  // Text fields save a moment after typing stops, and when they lose focus; never empty.
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const type = (next: Settings, field: 'userName' | 'outputLanguage') => {
    setDraft(next);
    clearTimeout(typing.current);
    if (next[field].trim()) typing.current = setTimeout(() => commit(next, field), 800);
  };
  const leave = (field: 'userName' | 'outputLanguage') => {
    if (!draft || !settings.data) return;
    clearTimeout(typing.current);
    if (!draft[field].trim()) setDraft({ ...draft, [field]: settings.data[field] });
    else if (draft[field] !== settings.data[field]) commit(draft, field);
  };
  const status = (field: keyof Settings) => (
    <span className={ui.success} aria-live="polite">
      {saved === field && !save.isPending ? `✓ ${t('settings.saved')}` : ''}
    </span>
  );

  const [revoking, setRevoking] = useState<Device | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/devices/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['devices'] }),
    onSettled: () => setRevoking(null),
  });
  const logout = useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSettled: () => {
      setToken(null);
      queryClient.clear();
    },
  });

  if (!draft) return <div className={ui.page}>{t('common.loading')}</div>;

  return (
    <div className={ui.page}>
      <h2 className={ui.title}>{t('nav.settings')}</h2>
      <div className={ui.form}>
        <div className={ui.row}>
          <Field label={t('settings.userName')} status={status('userName')}>
            <input
              className={ui.input}
              required
              value={draft.userName}
              onChange={(e) => type({ ...draft, userName: e.target.value }, 'userName')}
              onBlur={() => leave('userName')}
            />
          </Field>
          <Field label={t('settings.outputLanguage')} status={status('outputLanguage')}>
            <input
              className={ui.input}
              required
              value={draft.outputLanguage}
              onChange={(e) => type({ ...draft, outputLanguage: e.target.value }, 'outputLanguage')}
              onBlur={() => leave('outputLanguage')}
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
            <Field key={key} label={t(label)} status={status(key)}>
              <select
                className={ui.input}
                value={draft[key] ?? ''}
                onChange={(e) => commit({ ...draft, [key]: e.target.value || null }, key)}
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
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="checkbox"
            checked={draft.canonReview}
            onChange={(e) => commit({ ...draft, canonReview: e.target.checked }, 'canonReview')}
          />
          {t('settings.canonReview')}
          {status('canonReview')}
        </label>
        <ErrorText error={save.error} onRetry={() => save.mutate(draft)} />
      </div>

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

      <AppearanceSettings />

      <h3>{t('settings.devices')}</h3>
      <ul className={ui.list}>
        {devices.data?.map((d) => (
          <li key={d.id} className={ui.listItem}>
            <span className={ui.grow}>
              {d.name} {d.current && <span className={ui.muted}>({t('settings.thisDevice')})</span>}
            </span>
            {!d.current && (
              <button className={ui.ghost} type="button" onClick={() => setRevoking(d)}>
                {t('settings.revoke')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className={ui.actions} style={{ justifyContent: 'flex-start', marginBottom: 16 }}>
        <PairDevice devices={devices.data} />
      </div>
      <button className={ui.danger} type="button" onClick={() => setLoggingOut(true)}>
        {t('auth.logout')}
      </button>
      {revoking && (
        <ConfirmDialog
          danger
          title={t('settings.revokeTitle', { name: revoking.name })}
          confirm={t('settings.revoke')}
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate(revoking.id)}
          onCancel={() => setRevoking(null)}
        >
          <p>{t('settings.revokeHint')}</p>
        </ConfirmDialog>
      )}
      {loggingOut && (
        <ConfirmDialog
          danger
          title={t('settings.logoutTitle')}
          confirm={t('auth.logout')}
          pending={logout.isPending}
          onConfirm={() => logout.mutate()}
          onCancel={() => setLoggingOut(false)}
        >
          <p>{t('settings.logoutHint')}</p>
        </ConfirmDialog>
      )}

      <ConnectionSettings />

      <h3>{t('settings.about')}</h3>
      <p className={ui.muted}>
        {t('settings.appVersion', { version: TEAHOUSE_VERSION })}
        {serverVersion?.server && (
          <>
            <br />
            {t('settings.serverVersion', { version: serverVersion.server })}
          </>
        )}
      </p>
    </div>
  );
}
