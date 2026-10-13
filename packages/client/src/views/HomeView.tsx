import { useQuery } from '@tanstack/react-query';
import type { Chat, World } from '@teahouse/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../api.ts';
import { CharacterRow, GroupChatStart } from '../components/StartChat.tsx';
import ui from '../components/ui.module.css';
import { useCharacters, useWorlds } from '../queries.ts';
import styles from './HomeView.module.css';

export function HomeView() {
  const { t } = useTranslation();
  const worlds = useWorlds();
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => api.get<Chat[]>('/api/chats') });

  return (
    <div className={ui.page}>
      {/* On larger screens the sidebar lists the chats. */}
      {Boolean(chats.data?.length) && (
        <section className={ui.phoneOnly}>
          <h2 className={ui.title}>{t('nav.chats')}</h2>
          <ul className={ui.list}>
            {chats.data?.map((chat) => (
              <li key={chat.id}>
                <Link className={`${ui.listItem} ${styles.chat}`} to={`/chats/${chat.id}`}>
                  <span>{chat.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {worlds.data?.length === 0 ? (
        <p className={ui.muted}>
          {t('home.noWorlds')} <Link to="/worlds">{t('home.toWorlds')}</Link>
        </p>
      ) : (
        <p className={ui.muted}>{t('chats.pick')}</p>
      )}
      {worlds.data?.map((world) => (
        <WorldCharacters key={world.id} world={world} />
      ))}
    </div>
  );
}

function WorldCharacters({ world }: { world: World }) {
  const characters = useCharacters(world.id);
  if (!characters.data?.length) return null;
  return (
    <>
      <h2 className={ui.title}>
        <Link to={`/worlds/${world.id}`}>{world.name}</Link>
      </h2>
      <ul className={ui.list}>
        {characters.data.map((c) => (
          <CharacterRow key={c.slug} worldId={world.id} character={c} />
        ))}
      </ul>
      <GroupChatStart worldId={world.id} characters={characters.data} />
    </>
  );
}
