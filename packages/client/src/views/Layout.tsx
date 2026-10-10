import { useQuery } from '@tanstack/react-query';
import type { Chat } from '@teahouse/shared';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useMatch } from 'react-router';
import { api } from '../api.ts';
import { OfflineDiagnosis } from '../components/ServerDiagnosis.tsx';
import { ChatsIcon, ProfilesIcon, SettingsIcon, WorldsIcon } from '../components/TabIcons.tsx';
import type { ConnectionState } from '../events.ts';
import { dismissNotice, useNotices } from '../notices.ts';
import { useOnline } from '../offline.ts';
import { useServerVersion, versionMessage } from '../version.ts';
import styles from './Layout.module.css';

export function Layout({ connection }: { connection: ConnectionState }) {
  const { t } = useTranslation();
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => api.get<Chat[]>('/api/chats') });
  const online = useOnline();
  const notices = useNotices();
  // Stays until a check after a reconnect finds a fitting server.
  const mismatch = versionMessage(useServerVersion());
  // On phones a chat takes the whole screen; its header leads back.
  const inChat = useMatch('/chats/:chatId') !== null;

  return (
    <div className={`${styles.shell} ${inChat ? styles.inChat : ''}`}>
      <aside className={styles.sidebar}>
        <h1 className={styles.brand}>
          <img className={styles.logo} src="/favicon.svg" alt="" />
          {t('app.name')}
        </h1>
        <nav className={styles.nav}>
          <NavLink className={styles.navLink} to="/worlds">
            {t('nav.worlds')}
          </NavLink>
          <NavLink className={styles.navLink} to="/profiles">
            {t('nav.profiles')}
          </NavLink>
          <NavLink className={styles.navLink} to="/settings">
            {t('nav.settings')}
          </NavLink>
        </nav>
        <ul className={styles.chatList}>
          {chats.data?.map((chat) => (
            <li key={chat.id}>
              <NavLink className={styles.chatLink} to={`/chats/${chat.id}`}>
                {chat.title}
              </NavLink>
            </li>
          ))}
        </ul>
      </aside>
      <main className={styles.main}>
        {!online ? (
          <div className={styles.banner}>
            {t('app.offlineMode')}
            <OfflineDiagnosis offline={!online} />
          </div>
        ) : (
          connection === 'closed' && <div className={styles.banner}>{t('app.offline')}</div>
        )}
        {mismatch && (
          <div className={`${styles.notice} ${styles.error}`} role="alert">
            <span>{mismatch}</span>
          </div>
        )}
        {notices.map((notice) => (
          <div
            key={notice.id}
            className={`${styles.notice} ${styles[notice.kind]}`}
            role={notice.kind === 'info' ? 'status' : 'alert'}
          >
            <span>{notice.text}</span>
            <button
              className={styles.dismiss}
              type="button"
              aria-label={t('common.dismiss')}
              onClick={() => dismissNotice(notice.id)}
            >
              ×
            </button>
          </div>
        ))}
        <div className={styles.scroll}>
          <Outlet />
        </div>
      </main>
      <nav className={styles.tabs}>
        <NavLink className={styles.tab} to="/" end>
          <ChatsIcon />
          {t('nav.chats')}
        </NavLink>
        <NavLink className={styles.tab} to="/worlds">
          <WorldsIcon />
          {t('nav.worlds')}
        </NavLink>
        <NavLink className={styles.tab} to="/profiles">
          <ProfilesIcon />
          {t('nav.profiles')}
        </NavLink>
        <NavLink className={styles.tab} to="/settings">
          <SettingsIcon />
          {t('nav.settings')}
        </NavLink>
      </nav>
    </div>
  );
}
