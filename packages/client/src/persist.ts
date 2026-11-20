import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import type { ChatPath } from '@teahouse/shared';

/** Longest a write waits for a stream to settle, for one that never does (a lost connection). */
export const MAX_HOLD_MS = 30_000;

/**
 * Holds back writes of the local copy while a reply streams. Every delta changes the cache,
 * and each write serializes all of it to IndexedDB, about once a second for a whole reply.
 * The reply is only worth keeping once it has settled, which is written as usual.
 */
export function holdWhileStreaming(
  persister: Persister,
  streaming: (client: PersistedClient) => boolean = hasStreamingReply,
  now: () => number = Date.now,
): Persister {
  let heldSince: number | null = null;
  return {
    ...persister,
    persistClient: (client) => {
      if (streaming(client)) {
        heldSince ??= now();
        if (now() - heldSince < MAX_HOLD_MS) return;
      }
      heldSince = null;
      return persister.persistClient(client);
    },
  };
}

/** Whether a chat in the cache ends on a reply that is still being written. */
export function hasStreamingReply(client: PersistedClient): boolean {
  return client.clientState.queries.some(
    (q) =>
      q.queryKey[0] === 'chat' &&
      (q.state.data as ChatPath | undefined)?.messages?.at(-1)?.status === 'streaming',
  );
}
