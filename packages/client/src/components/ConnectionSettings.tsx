import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getServer, isApp } from '../api.ts';
import {
  acceptedCertificates,
  forgetCertificate,
  setNativeTransport,
  usesNativeTransport,
} from '../transport.ts';
import styles from './ConnectionSettings.module.css';
import ui from './ui.module.css';

/** In the apps: how Teahouse connects to its server, and the certificates the user trusts. */
export function ConnectionSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const server = getServer();
  const [native, setNative] = useState(() => usesNativeTransport(server));
  const trusted = useQuery({
    queryKey: ['trusted-certificate', 'all'],
    enabled: isApp,
    networkMode: 'always',
    queryFn: acceptedCertificates,
  });
  const forget = useMutation({
    networkMode: 'always',
    mutationFn: (origin: string) => forgetCertificate(origin),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trusted-certificate'] }),
  });
  if (!isApp) return null;

  const toggle = () => {
    setNativeTransport(server, !native);
    setNative(!native);
  };

  return (
    <>
      <h3>{t('settings.connection')}</h3>
      {server.startsWith('https:') && (
        <div className={ui.listItem}>
          <span className={ui.grow}>
            {native ? t('settings.throughApp') : t('settings.throughWebview')}
          </span>
          <button className={ui.ghost} type="button" onClick={toggle}>
            {native ? t('settings.useWebview') : t('settings.useApp')}
          </button>
        </div>
      )}
      <p className={ui.muted}>{t('settings.connectionHint')}</p>

      <h4>{t('settings.trustedCertificates')}</h4>
      {trusted.data?.length ? (
        <ul className={ui.list}>
          {trusted.data.map((certificate) => (
            <li key={certificate.origin} className={ui.listItem}>
              <span className={`${ui.grow} ${styles.server}`}>
                {certificate.origin}
                <br />
                <span className={`${ui.muted} ${styles.fingerprint}`}>{certificate.sha256}</span>
              </span>
              <button
                className={ui.ghost}
                type="button"
                disabled={forget.isPending}
                onClick={() => forget.mutate(certificate.origin)}
              >
                {t('settings.forget')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={ui.muted}>{t('settings.noTrustedCertificates')}</p>
      )}
    </>
  );
}
