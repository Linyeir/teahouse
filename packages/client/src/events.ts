import type { QueryClient } from '@tanstack/react-query';
import type { ChatPath, ServerEvent } from '@teahouse/shared';
import { useEffect, useState } from 'react';
import { getToken } from './api.ts';
import { applyUpdate, type PathUpdate, StreamBuffers } from './chat-state.ts';

export const streamBuffers = new StreamBuffers();

export type ConnectionState = 'connecting' | 'open' | 'closed';

/** Keeps a WebSocket to the server open and feeds its events into the query cache. */
export function useServerEvents(queryClient: QueryClient, enabled: boolean): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      const token = getToken();
      if (!token) return;
      setState('connecting');
      const url = new URL('/api/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('token', token);
      socket = new WebSocket(url);
      socket.onopen = () => {
        attempt = 0;
        setState('open');
        // Events may have been missed while disconnected.
        void queryClient.invalidateQueries();
      };
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as ServerEvent;
        const key = ['chat', event.chatId];
        const current = queryClient.getQueryData<ChatPath>(key);
        const cachedText =
          event.type === 'generation.delta'
            ? current?.messages.find((m) => m.id === event.messageId)?.content
            : undefined;
        const text = streamBuffers.apply(event, cachedText);

        let update: PathUpdate | null = null;
        if (event.type === 'generation.started')
          update = { type: 'started', message: event.message };
        if (event.type === 'generation.finished') {
          update = { type: 'finished', message: event.message };
        }
        if (event.type === 'generation.delta' && text) {
          update = { type: 'content', messageId: event.messageId, content: text };
        }

        const next = current && update ? applyUpdate(current, update) : null;
        if (next) queryClient.setQueryData(key, next);
        else void queryClient.invalidateQueries({ queryKey: key });
        if (event.type !== 'generation.delta') {
          void queryClient.invalidateQueries({ queryKey: ['chats'] });
        }
      };
      socket.onclose = () => {
        setState('closed');
        if (stopped) return;
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15_000));
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [queryClient, enabled]);

  return state;
}
