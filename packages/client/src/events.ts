import type { QueryClient } from '@tanstack/react-query';
import type { ChatPath, ServerEvent } from '@teahouse/shared';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getToken, serverUrl, setToken } from './api.ts';
import { applyUpdate, type PathUpdate, StreamBuffers } from './chat-state.ts';

export const streamBuffers = new StreamBuffers();

export type ConnectionState = 'connecting' | 'open' | 'closed';

// The current connection state, readable outside the component that owns the socket.
let connection: ConnectionState = 'connecting';
const listeners = new Set<() => void>();
function publish(state: ConnectionState) {
  connection = state;
  for (const listener of listeners) listener();
}

/** Whether live events arrive; views fall back to polling when they do not. */
export function useConnection(): ConnectionState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => connection,
  );
}

/** Keeps a WebSocket to the server open and feeds its events into the query cache. */
export function useServerEvents(queryClient: QueryClient, enabled: boolean): ConnectionState {
  const [state, setLocalState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    if (!enabled) return;
    const setState = (next: ConnectionState) => {
      setLocalState(next);
      publish(next);
    };
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      const token = getToken();
      if (!token) return;
      setState('connecting');
      const url = new URL(serverUrl('/api/ws'), window.location.href);
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
        if (event.type === 'devices.changed') {
          void queryClient.invalidateQueries({ queryKey: ['devices'] });
          return;
        }
        const key = ['chat', event.chatId];
        if (event.type === 'proposal.changed') {
          void queryClient.invalidateQueries({ queryKey: ['proposal', event.sceneId] });
          void queryClient.invalidateQueries({ queryKey: key });
          return;
        }
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
      socket.onclose = (close) => {
        setState('closed');
        if (stopped) return;
        // The server closes with 4401 when this device was signed out elsewhere.
        if (close.code === 4401) {
          setToken(null);
          return;
        }
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
