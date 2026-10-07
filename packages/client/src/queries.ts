import { queryOptions, useQuery } from '@tanstack/react-query';
import type { CharacterSummary, ChatPath, World, WorldBackground } from '@teahouse/shared';
import { api } from './api.ts';
import { mergeFetched, streamBuffers } from './chat-state.ts';

// Shared by the views and by the sync, which fills the local copy ahead of time.

export const worldsQuery = queryOptions({
  queryKey: ['worlds'],
  queryFn: () => api.get<World[]>('/api/worlds'),
});

export const charactersQuery = (worldId: string | undefined) =>
  queryOptions({
    queryKey: ['worlds', worldId, 'characters'],
    queryFn: () => api.get<CharacterSummary[]>(`/api/worlds/${worldId}/characters`),
    enabled: Boolean(worldId),
  });

export const backgroundsQuery = (worldId: string | undefined) =>
  queryOptions({
    queryKey: ['worlds', worldId, 'backgrounds'],
    queryFn: () => api.get<WorldBackground[]>(`/api/worlds/${worldId}/backgrounds`),
    enabled: Boolean(worldId),
  });

export const chatPathQuery = (chatId: string) =>
  queryOptions({
    queryKey: ['chat', chatId],
    queryFn: async () =>
      mergeFetched(await api.get<ChatPath>(`/api/chats/${chatId}`), streamBuffers),
  });

export const useWorlds = () => useQuery(worldsQuery);

export const useCharacters = (worldId: string | undefined) => useQuery(charactersQuery(worldId));
