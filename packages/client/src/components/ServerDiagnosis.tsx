import { openUrl } from '@tauri-apps/plugin-opener';
import { type MouseEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getServer, isApp } from '../api.ts';
import { type Certificate, type Diagnosis, useDiagnosis } from '../diagnose.ts';
import { openAppSettings, requestLocalNetwork } from '../localNetwork.ts';
import type { NetworkError } from '../offline.ts';
import styles from './ServerDiagnosis.module.css';
import ui from './ui.module.css';

const HTTPS_DOCS = 'https://github.com/Linyeir/teahouse/blob/main/docs/https.md';

/** A request that never reached the server; the apps also say why. */
export function NetworkErrorText({ error }: { error: NetworkError }) {
  const { t } = useTranslation();
  const server = getServer();
  const diagnosis = useDiagnosis(server, isApp && error);
  return (
    <div className={ui.error} role="alert">
      <p className={styles.text}>{t('server.unreachable')}</p>
      {isApp &&
        (diagnosis ? (
          <DiagnosisText diagnosis={diagnosis} server={server} />
        ) : (
          <p className={`${styles.text} ${ui.muted}`}>{t('server.checking')}</p>
        ))}
    </div>
  );
}

/**
 * For the offline banner: says why the app is offline, unless the reason is the ordinary one
 * (the server is out of reach), which the banner covers already.
 */
export function OfflineDiagnosis({ offline }: { offline: boolean }) {
  const server = getServer();
  const diagnosis = useDiagnosis(server, isApp && offline);
  if (!diagnosis || diagnosis.kind === 'unreachable' || diagnosis.kind === 'reachable') {
    return null;
  }
  return (
    <div className={styles.offline}>
      <DiagnosisText diagnosis={diagnosis} server={server} />
    </div>
  );
}

function DiagnosisText({ diagnosis, server }: { diagnosis: Diagnosis; server: string }) {
  const { t } = useTranslation();
  switch (diagnosis.kind) {
    case 'reachable':
      return <p className={styles.text}>{t('server.reachable')}</p>;
    case 'gateway':
      return <p className={styles.text}>{t('server.gateway')}</p>;
    case 'blocked':
      return <p className={styles.text}>{t('server.blocked')}</p>;
    case 'localNetwork':
      return <LocalNetwork />;
    case 'unreachable':
      return (
        <>
          <p className={styles.text}>{t('server.down', { server })}</p>
          {diagnosis.reason && <p className={styles.reason}>{diagnosis.reason}</p>}
        </>
      );
    case 'tlsFailed':
      return (
        <>
          <p className={styles.text}>{t('server.tlsFailed', { server })}</p>
          <p className={styles.reason}>{diagnosis.reason}</p>
        </>
      );
    case 'untrusted':
      return <Untrusted certificate={diagnosis.certificate} server={server} />;
  }
}

function LocalNetwork() {
  const { t } = useTranslation();
  // After the second refusal Android stops asking: then only the settings page helps.
  const [answer, setAnswer] = useState<'granted' | 'refused'>();
  if (answer === 'granted') return <p className={styles.text}>{t('server.localNetworkGranted')}</p>;
  const warn = (err: unknown) => console.warn('Local network permission:', err);
  const allow = () =>
    void requestLocalNetwork().then((granted) => setAnswer(granted ? 'granted' : 'refused'), warn);
  return (
    <>
      <p className={styles.text}>
        {answer === 'refused' ? t('server.localNetworkRefused') : t('server.localNetwork')}
      </p>
      <p className={styles.text}>
        {answer === 'refused' ? (
          <button
            className={ui.button}
            type="button"
            onClick={() => void openAppSettings().catch(warn)}
          >
            {t('server.localNetworkSettingsOpen')}
          </button>
        ) : (
          <button className={ui.button} type="button" onClick={allow}>
            {t('server.localNetworkAllow')}
          </button>
        )}
      </p>
    </>
  );
}

function Untrusted({ certificate: cert, server }: { certificate: Certificate; server: string }) {
  const { t, i18n } = useTranslation();
  const date = (seconds: number) =>
    new Date(seconds * 1000).toLocaleDateString(i18n.language, { dateStyle: 'medium' });
  const now = Date.now() / 1000;
  const host = new URL(server).hostname;

  // The most likely cause first; each one alone is enough to be rejected.
  const problems: string[] = [];
  if (cert.notAfter !== null && cert.notAfter < now) {
    problems.push(t('server.certExpired', { date: date(cert.notAfter) }));
  }
  if (cert.notBefore !== null && cert.notBefore > now) {
    problems.push(t('server.certNotYetValid', { date: date(cert.notBefore) }));
  }
  if (!cert.matchesHost) problems.push(t('server.certWrongHost', { host }));
  if (cert.selfSigned) problems.push(t('server.certSelfSigned'));
  if (problems.length === 0) {
    problems.push(
      /Android/i.test(navigator.userAgent)
        ? t('server.certUnknownCaAndroid')
        : t('server.certUnknownCa'),
    );
  }

  const openDocs = (e: MouseEvent) => {
    e.preventDefault();
    void openUrl(HTTPS_DOCS);
  };

  return (
    <>
      <p className={styles.text}>{t('server.untrusted')}</p>
      <ul className={styles.problems}>
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <dl className={styles.certificate}>
        {cert.subject && (
          <>
            <dt>{t('server.certSubject')}</dt>
            <dd>{cert.subject}</dd>
          </>
        )}
        {cert.issuer && (
          <>
            <dt>{t('server.certIssuer')}</dt>
            <dd>{cert.issuer}</dd>
          </>
        )}
        {cert.notBefore !== null && cert.notAfter !== null && (
          <>
            <dt>{t('server.certValidity')}</dt>
            <dd>
              {date(cert.notBefore)} – {date(cert.notAfter)}
            </dd>
          </>
        )}
        <dt>{t('server.certFingerprint')}</dt>
        <dd className={styles.fingerprint}>{cert.sha256}</dd>
      </dl>
      <p className={styles.text}>
        <a href={HTTPS_DOCS} onClick={openDocs}>
          {t('server.httpsDocs')}
        </a>
      </p>
    </>
  );
}
