import { useQuery } from '@tanstack/react-query';
import type { Chat } from '@teahouse/shared';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { api } from '../api.ts';
import type { ConnectionState } from '../events.ts';
import { dismissNotice, useNotices } from '../notices.ts';
import { useOnline } from '../offline.ts';
import styles from './Layout.module.css';

export function Layout({ connection }: { connection: ConnectionState }) {
  const { t } = useTranslation();
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => api.get<Chat[]>('/api/chats') });
  const online = useOnline();
  const notices = useNotices();

  return (
    <div className={styles.shell}>
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
          <div className={styles.banner}>{t('app.offlineMode')}</div>
        ) : (
          connection === 'closed' && <div className={styles.banner}>{t('app.offline')}</div>
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
    </div>
  );
}
