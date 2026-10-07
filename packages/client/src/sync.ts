import type { QueryClient } from '@tanstack/react-query';
import type { Chat, ChatPath, SyncChanges } from '@teahouse/shared';
import { api, getServer } from './api.ts';
import { backgroundsQuery, charactersQuery, chatPathQuery, worldsQuery } from './queries.ts';

/** How many chats the local copy holds at most, newest first. */
export const LOCAL_CHATS = 30;

const cursorKey = () => `teahouse.syncCursor:${getServer() || window.location.origin}`;

function readCursor(): string | null {
  try {
    return localStorage.getItem(cursorKey());
  } catch {
    return null;
  }
}

function writeCursor(cursor: string | null): void {
  try {
    if (cursor) localStorage.setItem(cursorKey(), cursor);
    else localStorage.removeItem(cursorKey());
  } catch {
    // Without storage every sync is a full one, which is only slower.
  }
}

/** Forgets the sync position, e.g. on sign-out, so the next sign-in fetches everything. */
export const resetSync = () => writeCursor(null);

let running: Promise<void> | null = null;

/**
 * Brings the local copy up to date after (re)connecting (concept, section 9): fetches the
 * chats that changed since the last sync, plus what their views need, so they can be read
 * offline. The cursor only advances when everything arrived.
 */
export function syncLocalCopy(queryClient: QueryClient): Promise<void> {
  running ??= run(queryClient).finally(() => {
    running = null;
  });
  return running;
}

async function run(queryClient: QueryClient): Promise<void> {
  const since = readCursor();
  const changes = await api.get<SyncChanges>(
    `/api/sync/changes${since ? `?since=${encodeURIComponent(since)}` : ''}`,
  );
  for (const id of changes.deleted) queryClient.removeQueries({ queryKey: ['chat', id] });

  const list = await queryClient.fetchQuery({
    queryKey: ['chats'],
    queryFn: () => api.get<Chat[]>('/api/chats'),
    staleTime: 0,
  });
  const changed = new Set(changes.chats);
  const kept = list.slice(0, LOCAL_CHATS);
  // Changed chats, plus kept ones the local copy lacks (e.g. evicted, or a fresh install).
  const due = kept.filter(
    (c) => changed.has(c.id) || !queryClient.getQueryData<ChatPath>(['chat', c.id]),
  );
  // Older chats fall out of the local copy; they load again when opened online.
  for (const c of list.slice(LOCAL_CHATS)) {
    if (
      !queryClient
        .getQueryCache()
        .find({ queryKey: ['chat', c.id] })
        ?.getObserversCount()
    ) {
      queryClient.removeQueries({ queryKey: ['chat', c.id], exact: true });
    }
  }

  await Promise.all(
    due.map((c) => queryClient.fetchQuery({ ...chatPathQuery(c.id), staleTime: 0 })),
  );
  const worldIds = [...new Set(kept.map((c) => c.worldId))];
  await Promise.all([
    queryClient.prefetchQuery(worldsQuery),
    ...worldIds.flatMap((id) => [
      queryClient.prefetchQuery(charactersQuery(id)),
      queryClient.prefetchQuery(backgroundsQuery(id)),
    ]),
  ]);
  writeCursor(changes.cursor);
}
