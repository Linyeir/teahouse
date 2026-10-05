import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CharacterSummary,
  type ChatPath,
  renderTemplate,
  type Settings,
} from '@teahouse/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api, assetUrl } from '../api.ts';
import styles from './StartChat.module.css';
import ui from './ui.module.css';

export function useStartChat() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { worldId: string; characterSlug: string; greetingIndex: number }) =>
      api.post<ChatPath>('/api/chats', input),
    onSuccess: (path) => {
      queryClient.setQueryData(['chat', path.chat.id], path);
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      navigate(`/chats/${path.chat.id}`);
    },
  });
}

export function Avatar({ worldId, character }: { worldId: string; character?: CharacterSummary }) {
  const image = character?.images.find((i) => i.label === 'neutral') ?? character?.images[0];
  return image ? (
    <img className={styles.avatar} src={assetUrl(worldId, image.file)} alt="" />
  ) : (
    <span className={styles.avatar} aria-hidden>
      {character?.name.slice(0, 1) ?? '?'}
    </span>
  );
}

/** A character row with a "start chat" action and, if there are several, a greeting choice. */
export function CharacterRow({
  worldId,
  character,
}: {
  worldId: string;
  character: CharacterSummary;
}) {
  const { t } = useTranslation();
  const start = useStartChat();
  const [greeting, setGreeting] = useState(0);
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/api/settings'),
  });
  const render = (text: string) =>
    renderTemplate(text, { char: character.name, user: settings.data?.userName ?? 'User' });

  return (
    <li className={ui.listItem}>
      <Avatar worldId={worldId} character={character} />
      <div className={ui.grow}>
        <div>{character.name}</div>
        {character.summary && <div className={ui.hint}>{render(character.summary)}</div>}
      </div>
      {character.greetings.length > 1 && (
        <select
          className={`${ui.input} ${styles.greeting}`}
          aria-label={t('worlds.greeting')}
          value={greeting}
          onChange={(e) => setGreeting(Number(e.target.value))}
        >
          {character.greetings.map((g, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: greetings are addressed by index
            <option key={i} value={i}>
              {t('worlds.greetingN', { n: i + 1 })}: {render(g).slice(0, 60)}
            </option>
          ))}
        </select>
      )}
      <button
        className={ui.primary}
        type="button"
        disabled={start.isPending}
        onClick={() =>
          start.mutate({ worldId, characterSlug: character.slug, greetingIndex: greeting })
        }
      >
        {t('worlds.startChat')}
      </button>
    </li>
  );
}
