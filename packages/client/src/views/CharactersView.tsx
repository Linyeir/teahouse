import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Character, CharacterInput, ChatPath } from '@teahouse/shared';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../api.ts';
import { ErrorText, Field } from '../components/Field.tsx';
import ui from '../components/ui.module.css';

const empty: CharacterInput = { name: '', description: '', firstMessage: '' };

export function useStartChat() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (characterId: string) => api.post<ChatPath>('/api/chats', { characterId }),
    onSuccess: (path) => {
      queryClient.setQueryData(['chat', path.chat.id], path);
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      navigate(`/chats/${path.chat.id}`);
    },
  });
}

export function CharactersView() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const characters = useQuery({
    queryKey: ['characters'],
    queryFn: () => api.get<Character[]>('/api/characters'),
  });
  const [editing, setEditing] = useState<{ id: string | null; data: CharacterInput } | null>(null);
  const startChat = useStartChat();

  const save = useMutation({
    mutationFn: ({ id, data }: { id: string | null; data: CharacterInput }) =>
      id ? api.put(`/api/characters/${id}`, data) : api.post('/api/characters', data),
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['characters'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/characters/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['characters'] }),
  });

  if (editing) {
    const set = (patch: Partial<CharacterInput>) =>
      setEditing({ ...editing, data: { ...editing.data, ...patch } });
    const onSubmit = (e: FormEvent) => {
      e.preventDefault();
      save.mutate(editing);
    };
    return (
      <div className={ui.page}>
        <h2 className={ui.title}>{editing.id ? editing.data.name : t('characters.new')}</h2>
        <form className={ui.form} onSubmit={onSubmit}>
          <Field label={t('characters.name')}>
            <input
              className={ui.input}
              required
              value={editing.data.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label={t('characters.description')} hint={t('characters.descriptionHint')}>
            <textarea
              className={ui.input}
              rows={10}
              value={editing.data.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
          <Field label={t('characters.firstMessage')}>
            <textarea
              className={ui.input}
              rows={5}
              value={editing.data.firstMessage}
              onChange={(e) => set({ firstMessage: e.target.value })}
            />
          </Field>
          <ErrorText error={save.error} />
          <div className={ui.actions}>
            <button className={ui.button} type="button" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
            <button className={ui.primary} type="submit" disabled={save.isPending}>
              {t('common.save')}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className={ui.page}>
      <h2 className={ui.title}>{t('nav.characters')}</h2>
      {characters.data?.length === 0 && <p className={ui.muted}>{t('characters.empty')}</p>}
      <ul className={ui.list}>
        {characters.data?.map((c) => (
          <li key={c.id} className={ui.listItem}>
            <span className={ui.grow}>{c.name}</span>
            <button
              className={ui.ghost}
              type="button"
              onClick={() => {
                if (window.confirm(t('common.confirmDelete', { name: c.name })))
                  remove.mutate(c.id);
              }}
            >
              {t('common.delete')}
            </button>
            <button
              className={ui.button}
              type="button"
              onClick={() =>
                setEditing({
                  id: c.id,
                  data: { name: c.name, description: c.description, firstMessage: c.firstMessage },
                })
              }
            >
              {t('common.edit')}
            </button>
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
      <button
        className={ui.primary}
        type="button"
        onClick={() => setEditing({ id: null, data: empty })}
      >
        {t('characters.new')}
      </button>
    </div>
  );
}
