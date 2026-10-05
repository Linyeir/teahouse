import { useMutation, useQuery } from '@tanstack/react-query';
import type { AuthStatus, TokenResponse } from '@teahouse/shared';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, setToken } from '../api.ts';
import { ErrorText, Field } from '../components/Field.tsx';
import ui from '../components/ui.module.css';

const defaultDeviceName = () => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua)
    ? 'Android'
    : /Mac/.test(ua)
      ? 'macOS'
      : /Win/.test(ua)
        ? 'Windows'
        : /Linux/.test(ua)
          ? 'Linux'
          : 'Device';
  return `Browser on ${os}`;
};

export function AuthView() {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: ['auth-status'],
    queryFn: () => api.get<AuthStatus>('/api/auth/status'),
  });
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const setup = status.data?.passwordSet === false;

  const submit = useMutation({
    mutationFn: () =>
      api.post<TokenResponse>(setup ? '/api/auth/setup' : '/api/auth/login', {
        password,
        deviceName,
      }),
    onSuccess: ({ token }) => setToken(token),
  });

  if (!status.data) return <div className={ui.page}>{t('common.loading')}</div>;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  return (
    <div className={ui.page} style={{ maxWidth: 420, paddingTop: '15vh' }}>
      <h1 className={ui.title}>{setup ? t('auth.setupTitle') : t('auth.loginTitle')}</h1>
      {setup && <p className={ui.muted}>{t('auth.setupHint')}</p>}
      <form className={ui.form} onSubmit={onSubmit}>
        <Field label={t('auth.password')}>
          <input
            className={ui.input}
            type="password"
            minLength={8}
            required
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t('auth.deviceName')}>
          <input
            className={ui.input}
            required
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
          />
        </Field>
        <ErrorText error={submit.error} />
        <button className={ui.primary} type="submit" disabled={submit.isPending}>
          {setup ? t('auth.setup') : t('auth.login')}
        </button>
      </form>
    </div>
  );
}
