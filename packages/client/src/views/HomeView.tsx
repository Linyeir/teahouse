import { useQuery } from '@tanstack/react-query';
import type { Character, Chat } from '@teahouse/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../api.ts';
import ui from '../components/ui.module.css';
import { useStartChat } from './CharactersView.tsx';

export function HomeView() {
  const { t } = useTranslation();
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => api.get<Chat[]>('/api/chats') });
  const characters = useQuery({
    queryKey: ['characters'],
    queryFn: () => api.get<Character[]>('/api/characters'),
  });
  const startChat = useStartChat();

  return (
    <div className={ui.page}>
      <p className={ui.muted}>{chats.data?.length ? t('chats.pick') : t('chats.empty')}</p>
      {characters.data?.length ? (
        <>
          <h2 className={ui.title}>{t('chats.start')}</h2>
          <ul className={ui.list}>
            {characters.data.map((c) => (
              <li key={c.id} className={ui.listItem}>
                <span className={ui.grow}>{c.name}</span>
                <button
                  className={ui.primary}
                  type="button"
                  disabled={startChat.isPending}
                  onClick={() => startChat.mutate(c.id)}
                >
                  {t('characters.startChat')}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Link to="/characters">{t('characters.new')}</Link>
      )}
    </div>
  );
}
