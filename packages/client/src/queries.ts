import { useQuery } from '@tanstack/react-query';
import type { CharacterSummary, World } from '@teahouse/shared';
import { api } from './api.ts';

export const useWorlds = () =>
  useQuery({ queryKey: ['worlds'], queryFn: () => api.get<World[]>('/api/worlds') });

export const useCharacters = (worldId: string | undefined) =>
  useQuery({
    queryKey: ['worlds', worldId, 'characters'],
    queryFn: () => api.get<CharacterSummary[]>(`/api/worlds/${worldId}/characters`),
    enabled: Boolean(worldId),
  });
