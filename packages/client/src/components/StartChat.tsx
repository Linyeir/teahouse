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
    mutationFn: (input: {
      worldId: string;
      characterSlug: string;
      greetingIndex: number;
      cast?: string[];
    }) => api.post<ChatPath>('/api/chats', input),
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
    <li className={`${ui.card} ${styles.item}`}>
      <div className={styles.row}>
        <Avatar worldId={worldId} character={character} />
        <div className={styles.info}>
          <div>{character.name}</div>
          {character.summary && (
            <div className={`${ui.hint} ${styles.summary}`}>{render(character.summary)}</div>
          )}
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
          className={`${ui.primary} ${styles.start}`}
          type="button"
          disabled={start.isPending}
          onClick={() =>
            start.mutate({ worldId, characterSlug: character.slug, greetingIndex: greeting })
          }
        >
          {t('worlds.startChat')}
        </button>
      </div>
    </li>
  );
}

/**
 * Starts a chat with several characters: who is there from the start, and whose greeting
 * opens it. Others can still join later through the picker.
 */
export function GroupChatStart({
  worldId,
  characters,
}: {
  worldId: string;
  characters: CharacterSummary[];
}) {
  const { t } = useTranslation();
  const start = useStartChat();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [opening, setOpening] = useState('');
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/api/settings'),
  });
  if (characters.length < 2) return null;
  if (!open) {
    return (
      <div className={ui.actions}>
        <button className={ui.button} type="button" onClick={() => setOpen(true)}>
          {t('worlds.groupChat')}
        </button>
      </div>
    );
  }

  // In the order of the list, which is also the order of the cast.
  const picked = characters.filter((c) => selected.has(c.slug));
  const openings = picked.flatMap((c) =>
    c.greetings.map((g, i) => ({
      value: `${c.slug}:${i}`,
      label: `${c.name}: ${renderTemplate(g, { char: c.name, user: settings.data?.userName ?? 'User' }).slice(0, 60)}`,
    })),
  );
  const chosen = openings.find((o) => o.value === opening)?.value ?? openings[0]?.value;
  const toggle = (slug: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(slug);
    else next.delete(slug);
    setSelected(next);
  };
  const submit = () => {
    const at = chosen?.lastIndexOf(':') ?? -1;
    const opener = chosen && at > 0 ? chosen.slice(0, at) : picked[0]?.slug;
    if (!opener) return;
    start.mutate({
      worldId,
      characterSlug: opener,
      greetingIndex: chosen && at > 0 ? Number(chosen.slice(at + 1)) : 0,
      cast: picked.map((c) => c.slug),
    });
  };

  return (
    <div className={`${ui.card} ${ui.form}`}>
      <fieldset className={styles.members}>
        <legend className={ui.hint}>{t('worlds.groupChatWho')}</legend>
        {characters.map((c) => (
          <label key={c.slug}>
            <input
              type="checkbox"
              checked={selected.has(c.slug)}
              onChange={(e) => toggle(c.slug, e.target.checked)}
            />{' '}
            {c.name}
          </label>
        ))}
      </fieldset>
      {openings.length > 0 && (
        <label className={ui.field}>
          {t('worlds.opening')}
          <select className={ui.input} value={chosen} onChange={(e) => setOpening(e.target.value)}>
            {openings.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className={ui.actions}>
        <button className={ui.button} type="button" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
        <button
          className={ui.primary}
          type="button"
          disabled={picked.length < 2 || start.isPending}
          onClick={submit}
        >
          {t('worlds.startGroupChat')}
        </button>
      </div>
    </div>
  );
}
