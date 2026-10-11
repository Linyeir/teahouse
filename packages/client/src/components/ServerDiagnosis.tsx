import { openUrl } from '@tauri-apps/plugin-opener';
import { type MouseEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getServer, isApp } from '../api.ts';
import { type Certificate, type Diagnosis, useDiagnosis } from '../diagnose.ts';
import { openAppSettings, requestLocalNetwork } from '../localNetwork.ts';
import type { NetworkError } from '../offline.ts';
import { acceptCertificate, connectThroughApp, forgetCertificate } from '../transport.ts';
import styles from './ServerDiagnosis.module.css';
import ui from './ui.module.css';

const HTTPS_DOCS = 'https://github.com/Linyeir/teahouse/blob/main/docs/https.md';

/**
 * A request that never reached the server; the apps also say why. `onRetry` repeats the failed
 * action once the user changed how the app connects (a view that does not refetch by itself).
 */
export function NetworkErrorText({
  error,
  onRetry,
}: {
  error: NetworkError;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const server = getServer();
  const diagnosis = useDiagnosis(server, isApp && error);
  return (
    <div className={ui.error} role="alert">
      <p className={styles.text}>{t('server.unreachable')}</p>
      {isApp &&
        (diagnosis ? (
          <DiagnosisText diagnosis={diagnosis} server={server} onRetry={onRetry} />
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
  // As often as the app checks whether the server is back (events.ts).
  const diagnosis = useDiagnosis(server, isApp && offline, 10_000);
  if (!diagnosis || diagnosis.kind === 'unreachable' || diagnosis.kind === 'reachable') {
    return null;
  }
  return (
    <div className={styles.offline}>
      <DiagnosisText diagnosis={diagnosis} server={server} />
    </div>
  );
}

function DiagnosisText({
  diagnosis,
  server,
  onRetry,
}: {
  diagnosis: Diagnosis;
  server: string;
  onRetry?: () => void;
}) {
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
      return <Untrusted certificate={diagnosis.certificate} server={server} onRetry={onRetry} />;
    case 'webviewOnly':
      return <WebviewOnly certificate={diagnosis.certificate} server={server} onRetry={onRetry} />;
    case 'certificateChanged':
      return (
        <CertificateChanged
          certificate={diagnosis.certificate}
          accepted={diagnosis.accepted}
          server={server}
        />
      );
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

function useDate() {
  const { i18n } = useTranslation();
  return (seconds: number) =>
    new Date(seconds * 1000).toLocaleDateString(i18n.language, { dateStyle: 'medium' });
}

function Untrusted({
  certificate: cert,
  server,
  onRetry,
}: {
  certificate: Certificate;
  server: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const date = useDate();
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

  return (
    <>
      <p className={styles.text}>{t('server.untrusted')}</p>
      <ul className={styles.problems}>
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <CertificateDetails certificate={cert} />
      <AcceptCertificate certificate={cert} server={server} onRetry={onRetry} />
      <DocsLink />
    </>
  );
}

/**
 * Trusting a certificate nobody vouches for: only after the user compared its fingerprint with
 * the one the server shows, so a machine in between cannot slip its own in.
 */
function AcceptCertificate({
  certificate,
  server,
  onRetry,
}: {
  certificate: Certificate;
  server: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'offer' | 'check' | 'accepted'>('offer');
  const [error, setError] = useState<string | null>(null);
  if (!isApp || !server.startsWith('https:')) return null;
  if (step === 'accepted') return <p className={styles.text}>{t('server.accepted')}</p>;
  if (step === 'offer') {
    return (
      <p className={styles.text}>
        <button className={ui.button} type="button" onClick={() => setStep('check')}>
          {t('server.acceptStart')}
        </button>
      </p>
    );
  }
  const { hostname, port } = new URL(server);
  const command = `openssl s_client -connect ${hostname}:${port || 443} -servername ${hostname} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`;
  const accept = () =>
    void acceptCertificate(server, certificate.sha256).then(
      () => {
        setStep('accepted');
        onRetry?.();
      },
      (err: unknown) => setError(String(err)),
    );
  return (
    <div className={styles.accept}>
      <p className={styles.text}>{t('server.acceptCheck')}</p>
      <pre className={styles.command}>{command}</pre>
      <p className={styles.text}>{t('server.acceptCompare')}</p>
      <p className={`${styles.fingerprint} ${styles.large}`}>{certificate.sha256}</p>
      {error && <p className={styles.reason}>{error}</p>}
      <div className={ui.actions} style={{ justifyContent: 'flex-start' }}>
        <button className={ui.primary} type="button" onClick={accept}>
          {t('server.acceptConfirm')}
        </button>
        <button className={ui.ghost} type="button" onClick={() => setStep('offer')}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

function WebviewOnly({
  certificate,
  server,
  onRetry,
}: {
  certificate: Certificate;
  server: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const [switched, setSwitched] = useState(false);
  return (
    <>
      <p className={styles.text}>{t('server.webviewOnly')}</p>
      <CertificateDetails certificate={certificate} />
      {switched ? (
        <p className={styles.text}>{t('server.switched')}</p>
      ) : (
        <p className={styles.text}>
          <button
            className={ui.button}
            type="button"
            onClick={() => {
              connectThroughApp(server);
              setSwitched(true);
              onRetry?.();
            }}
          >
            {t('server.connectThroughApp')}
          </button>
        </p>
      )}
    </>
  );
}

/** Never trusted again silently: the user forgets the old certificate, then checks the new one. */
function CertificateChanged({
  certificate,
  accepted,
  server,
}: {
  certificate: Certificate;
  accepted: string | null;
  server: string;
}) {
  const { t } = useTranslation();
  const [forgotten, setForgotten] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forget = () =>
    void forgetCertificate(server).then(
      () => setForgotten(true),
      (err: unknown) => setError(String(err)),
    );
  return (
    <div role="alert">
      <p className={styles.text}>
        <strong>{t('server.certChanged')}</strong>
      </p>
      <dl className={styles.certificate}>
        {accepted && (
          <>
            <dt>{t('server.certAccepted')}</dt>
            <dd className={styles.fingerprint}>{accepted}</dd>
          </>
        )}
        <dt>{t('server.certPresented')}</dt>
        <dd className={styles.fingerprint}>{certificate.sha256}</dd>
      </dl>
      {forgotten ? (
        <p className={styles.text}>{t('server.forgotten')}</p>
      ) : (
        <>
          <p className={styles.text}>{t('server.certChangedHint')}</p>
          {error && <p className={styles.reason}>{error}</p>}
          <p className={styles.text}>
            <button className={ui.button} type="button" onClick={forget}>
              {t('server.forgetCertificate')}
            </button>
          </p>
        </>
      )}
    </div>
  );
}

function CertificateDetails({ certificate: cert }: { certificate: Certificate }) {
  const { t } = useTranslation();
  const date = useDate();
  return (
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
  );
}

function DocsLink() {
  const { t } = useTranslation();
  const openDocs = (e: MouseEvent) => {
    e.preventDefault();
    void openUrl(HTTPS_DOCS);
  };
  return (
    <p className={styles.text}>
      <a href={HTTPS_DOCS} onClick={openDocs}>
        {t('server.httpsDocs')}
      </a>
    </p>
  );
}
