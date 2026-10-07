import type { QueryClient } from '@tanstack/react-query';
import type { ChatPath, EditMessageResult, SendMessageResult } from '@teahouse/shared';
import { api, RequestError } from './api.ts';
import { restoreDraft } from './drafts.ts';
import i18n from './i18n.ts';
import { pushNotice } from './notices.ts';
import { retryWhileOffline } from './offline.ts';

export interface SendVariables {
  chatId: string;
  /** Client-generated, so a replayed request does not send the message twice. */
  id: string;
  content: string;
  /** The leaf the user answered; the server forks when the chat has moved on. */
  parentId: string | null;
}

export interface EditVariables {
  chatId: string;
  id: string;
  content: string;
  baseRevision: number;
}

export const sendKey = (chatId: string) => ['send', chatId];
export const editKey = (chatId: string) => ['edit', chatId];

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Sending and editing can wait for the connection (concept, section 9). They are registered
 * by key rather than inline in a view, so a mutation restored from storage after a reload
 * still knows what to run.
 */
export function registerOfflineMutations(queryClient: QueryClient): void {
  const refresh = (chatId: string) => queryClient.invalidateQueries({ queryKey: ['chat', chatId] });

  queryClient.setMutationDefaults<SendMessageResult, Error, SendVariables>(['send'], {
    mutationFn: ({ chatId, id, content, parentId }) =>
      api.post<SendMessageResult>(`/api/chats/${chatId}/messages`, {
        id,
        content,
        ...(parentId && { parentId }),
      }),
    retry: retryWhileOffline,
    onSuccess: (result) => {
      if (result.forked) pushNotice(i18n.t('sync.forked'), 'warning');
    },
    onError: (err, { chatId, content }) => {
      // Without a profile the message is stored and only the reply failed.
      if (err instanceof RequestError && err.code === 'no_profile') {
        pushNotice(i18n.t('chats.noProfile'), 'error');
        return;
      }
      restoreDraft(chatId, content);
      pushNotice(i18n.t('sync.sendFailed', { message: reason(err) }), 'error');
    },
    onSettled: (_data, _err, { chatId }) => refresh(chatId),
  });

  queryClient.setMutationDefaults<EditMessageResult, Error, EditVariables>(['edit'], {
    mutationFn: ({ id, content, baseRevision }) =>
      api.put<EditMessageResult>(`/api/messages/${id}`, { content, baseRevision }),
    retry: retryWhileOffline,
    // Shown right away, also offline; the server's answer replaces it.
    onMutate: async ({ chatId, id, content }) => {
      await queryClient.cancelQueries({ queryKey: ['chat', chatId] });
      queryClient.setQueryData<ChatPath>(['chat', chatId], (path) =>
        path
          ? { ...path, messages: path.messages.map((m) => (m.id === id ? { ...m, content } : m)) }
          : path,
      );
    },
    onSuccess: (result) => {
      if (result.overwritten) pushNotice(i18n.t('sync.overwritten'), 'warning');
    },
    onError: (err) => {
      const closed = err instanceof RequestError && err.code === 'scene_closed';
      pushNotice(closed ? i18n.t('sync.editClosed') : reason(err), 'error');
    },
    onSettled: (_data, _err, { chatId }) => refresh(chatId),
  });
}
