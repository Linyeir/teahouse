import { onlineManager, type QueryClient } from '@tanstack/react-query';
import type { ChatPath, ServerEvent } from '@teahouse/shared';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, getToken, serverUrl, setToken } from './api.ts';
import { applyUpdate, type PathUpdate, streamBuffers } from './chat-state.ts';
import { setReachable } from './offline.ts';
import { syncLocalCopy } from './sync.ts';
import { checkServerVersion } from './version.ts';

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
        setReachable(true);
        // Events may have been missed while disconnected.
        void queryClient.invalidateQueries();
        void syncLocalCopy(queryClient).catch(() => {
          // Retried on the next connect; the views fetch what they show anyway.
        });
        // The server may have been updated (or downgraded) while the socket was down.
        void checkServerVersion().catch(() => {
          // Checked again on the next connect.
        });
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
        // A lost socket may be a server that is gone, or only a proxy dropping WebSockets.
        probe();
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15_000));
      };
    };

    // A plain request tells whether the server answers; it marks it (un)reachable itself.
    const probe = () => void api.get('/api/auth/status').catch(() => {});
    // The socket may survive a network drop, so it cannot be the only way back online.
    const probing = setInterval(() => {
      if (!onlineManager.isOnline()) probe();
    }, 10_000);
    window.addEventListener('online', probe);
    // Server reachable again: reconnect now instead of waiting out the backoff.
    const unsubscribe = onlineManager.subscribe((online) => {
      if (!online || stopped || (socket && socket.readyState !== WebSocket.CLOSED)) return;
      clearTimeout(retry);
      attempt = 0;
      connect();
    });

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(probing);
      window.removeEventListener('online', probe);
      unsubscribe();
      socket?.close();
    };
  }, [queryClient, enabled]);

  return state;
}
