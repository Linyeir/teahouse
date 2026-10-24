import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { RequestError } from '../api.ts';
import { NetworkError } from '../offline.ts';
import { NetworkErrorText } from './ServerDiagnosis.tsx';
import ui from './ui.module.css';

/**
 * An error with a way forward: every banner offers at least one action, Retry or a link to
 * where the cause can be fixed, so no error leaves the user stuck.
 */
export function ErrorBanner({
  error,
  onRetry,
  profileLink = false,
}: {
  error: unknown;
  onRetry?: () => void;
  /** Also links to Profiles, for errors that a profile's settings cause. */
  profileLink?: boolean;
}) {
  const { t } = useTranslation();
  if (!error) return null;
  if (error instanceof NetworkError) return <NetworkErrorText error={error} onRetry={onRetry} />;
  const noProfile = error instanceof RequestError && error.code === 'no_profile';
  const message = noProfile
    ? t('chats.noProfile')
    : error instanceof Error
      ? error.message
      : String(error);
  return (
    <div className={ui.banner} role="alert">
      <span className={ui.error}>{message}</span>
      <span className={ui.actions}>
        {(noProfile || profileLink) && (
          <Link className={ui.button} to="/profiles">
            {t('chats.openProfiles')}
          </Link>
        )}
        {onRetry && !noProfile && (
          <button className={ui.button} type="button" onClick={onRetry}>
            {t('common.retry')}
          </button>
        )}
      </span>
    </div>
  );
}

/** A reply that failed: try again, or fix the profile it used. */
export function GenerationError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <ErrorBanner error={new Error(t('chats.error', { message }))} onRetry={onRetry} profileLink />
  );
}

/** The composer without a model to answer: nothing can be sent until there is a profile. */
export function NoProfileNotice() {
  const { t } = useTranslation();
  return (
    <div className={ui.banner} role="status">
      <span>{t('chats.connectModel')}</span>
      <span className={ui.actions}>
        <Link className={ui.primary} to="/profiles">
          {t('chats.openProfiles')}
        </Link>
      </span>
    </div>
  );
}
