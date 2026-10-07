import { useMutation, useQuery } from '@tanstack/react-query';
import type { AuthStatus, TokenResponse } from '@teahouse/shared';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, getServer, isApp, normalizeServer, setServer, setToken } from '../api.ts';
import { ErrorText, Field } from '../components/Field.tsx';
import ui from '../components/ui.module.css';
import { parsePairing } from '../pairing.ts';
import { canScan, ScanError, scanQrCode } from '../scan.ts';

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
  return isApp ? `App on ${os}` : `Browser on ${os}`;
};

/** Claims a pairing code on `server` and signs this device in. */
async function claim(server: string | null, code: string, deviceName: string) {
  if (server !== null) setServer(server);
  const { token } = await api.post<TokenResponse>('/api/pairing/claim', { code, deviceName });
  setToken(token);
}

/** Signs in with a scanned pairing QR code (Android app only). */
function ScanButton() {
  const { t } = useTranslation();
  const scan = useMutation({
    mutationFn: async () => {
      const text = await scanQrCode();
      if (text === null) return;
      const pairing = parsePairing(text);
      if (!pairing) throw new Error(t('auth.invalidCode'));
      await claim(pairing.server, pairing.code, defaultDeviceName());
    },
  });
  if (!canScan) return null;
  return (
    <>
      <button
        className={ui.primary}
        type="button"
        disabled={scan.isPending}
        onClick={() => scan.mutate()}
      >
        {t('auth.scan')}
      </button>
      <ErrorText error={scan.error instanceof ScanError ? t('auth.cameraDenied') : scan.error} />
    </>
  );
}

export function AuthView() {
  const { t } = useTranslation();
  const [server, setServerDraft] = useState(getServer);
  // The apps have no origin server: they first ask where to connect.
  const [connected, setConnected] = useState(!isApp || getServer() !== '');
  const [mode, setMode] = useState<'password' | 'code'>('password');

  const connect = useMutation({
    mutationFn: async () => {
      // A pasted pairing link answers both questions at once and signs in directly.
      const pairing = parsePairing(server);
      if (pairing?.server) {
        await claim(pairing.server, pairing.code, defaultDeviceName());
        return;
      }
      setServer(normalizeServer(server));
      await api.get<AuthStatus>('/api/auth/status');
      setConnected(true);
    },
  });

  if (!connected) {
    const onSubmit = (e: FormEvent) => {
      e.preventDefault();
      connect.mutate();
    };
    return (
      <div className={ui.page} style={{ maxWidth: 420, paddingTop: '15vh' }}>
        <h1 className={ui.title}>{t('auth.connectTitle')}</h1>
        <p className={ui.muted}>{canScan ? t('auth.connectHintScan') : t('auth.connectHint')}</p>
        <div className={ui.form} style={{ marginBottom: 16 }}>
          <ScanButton />
        </div>
        <form className={ui.form} onSubmit={onSubmit}>
          <Field label={t('auth.server')}>
            <input
              className={ui.input}
              required
              inputMode="url"
              placeholder="http://192.168.1.10:8787"
              value={server}
              onChange={(e) => setServerDraft(e.target.value)}
            />
          </Field>
          <ErrorText error={connect.error} />
          <button className={ui.primary} type="submit" disabled={connect.isPending}>
            {t('auth.connect')}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={ui.page} style={{ maxWidth: 420, paddingTop: '15vh' }}>
      {mode === 'password' ? <PasswordForm /> : <CodeForm />}
      <div className={ui.actions} style={{ justifyContent: 'flex-start', marginTop: 16 }}>
        <button
          className={ui.ghost}
          type="button"
          onClick={() => setMode(mode === 'password' ? 'code' : 'password')}
        >
          {mode === 'password' ? t('auth.useCode') : t('auth.usePassword')}
        </button>
        {isApp && (
          <button className={ui.ghost} type="button" onClick={() => setConnected(false)}>
            {t('auth.changeServer', { server: getServer() })}
          </button>
        )}
      </div>
    </div>
  );
}

function PasswordForm() {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: ['auth-status', getServer()],
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

  if (status.error) return <ErrorText error={status.error} />;
  if (!status.data) return <p>{t('common.loading')}</p>;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  return (
    <>
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
    </>
  );
}

function CodeForm() {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const parsed = parsePairing(input);

  const submit = useMutation({
    mutationFn: () => {
      if (!parsed) throw new Error(t('auth.invalidCode'));
      return claim(parsed.server, parsed.code, deviceName);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  return (
    <>
      <h1 className={ui.title}>{t('auth.pairTitle')}</h1>
      <p className={ui.muted}>{t('auth.pairHint')}</p>
      <div className={ui.form} style={{ marginBottom: 16 }}>
        <ScanButton />
      </div>
      <form className={ui.form} onSubmit={onSubmit}>
        <Field label={t('auth.code')}>
          <input
            className={ui.input}
            required
            autoComplete="off"
            autoCapitalize="characters"
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
          {t('auth.pair')}
        </button>
      </form>
    </>
  );
}

/**
 * Target of a pairing link opened in a browser (`/pair#code=…`). Shown even when this
 * browser is signed in already, so pairing replaces the old session instead of failing.
 */
export function PairView({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const code = new URLSearchParams(window.location.hash.slice(1)).get('code') ?? '';
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const submit = useMutation({
    mutationFn: () => claim(null, code, deviceName),
    onSuccess: onDone,
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  return (
    <div className={ui.page} style={{ maxWidth: 420, paddingTop: '15vh' }}>
      <h1 className={ui.title}>{t('auth.pairTitle')}</h1>
      {code ? (
        <form className={ui.form} onSubmit={onSubmit}>
          <p className={ui.muted}>{t('auth.pairLinkHint')}</p>
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
            {t('auth.pair')}
          </button>
        </form>
      ) : (
        <CodeForm />
      )}
      <div className={ui.actions} style={{ justifyContent: 'flex-start', marginTop: 16 }}>
        <button className={ui.ghost} type="button" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
