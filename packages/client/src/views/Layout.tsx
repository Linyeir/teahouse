import { useQuery } from '@tanstack/react-query';
import type { Chat } from '@teahouse/shared';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { api } from '../api.ts';
import type { ConnectionState } from '../events.ts';
import styles from './Layout.module.css';

export function Layout({ connection }: { connection: ConnectionState }) {
  const { t } = useTranslation();
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => api.get<Chat[]>('/api/chats') });

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <h1 className={styles.brand}>{t('app.name')}</h1>
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
        {connection === 'closed' && <div className={styles.banner}>{t('app.offline')}</div>}
        <Outlet />
      </main>
    </div>
  );
}
