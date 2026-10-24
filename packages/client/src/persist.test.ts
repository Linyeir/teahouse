import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { describe, expect, it } from 'vitest';
import { hasStreamingReply, holdWhileStreaming, MAX_HOLD_MS } from './persist.ts';

/** The dehydrated cache with one chat whose last message has `status`. */
const cache = (status: string): PersistedClient =>
  ({
    timestamp: 0,
    buster: '',
    clientState: {
      mutations: [],
      queries: [
        {
          queryKey: ['chat', 'c1'],
          queryHash: '["chat","c1"]',
          state: { data: { messages: [{ id: 'm1', status }] } },
        },
      ],
    },
  }) as unknown as PersistedClient;

function counting() {
  const writes: PersistedClient[] = [];
  const persister: Persister = {
    persistClient: (client) => {
      writes.push(client);
    },
    restoreClient: () => undefined,
    removeClient: () => undefined,
  };
  return { writes, persister };
}

describe('persisting the local copy', () => {
  it('writes once when a reply that streamed for 10 s settles', () => {
    let clock = 0;
    const { writes, persister } = counting();
    const held = holdWhileStreaming(persister, hasStreamingReply, () => clock);
    // A delta about every 100 ms for 10 s.
    for (; clock < 10_000; clock += 100) held.persistClient(cache('streaming'));
    held.persistClient(cache('complete'));
    expect(writes).toHaveLength(1);
    expect(hasStreamingReply(writes[0] as PersistedClient)).toBe(false);
  });

  it('still writes when a stream does not settle', () => {
    let clock = 0;
    const { writes, persister } = counting();
    const held = holdWhileStreaming(persister, hasStreamingReply, () => clock);
    held.persistClient(cache('streaming'));
    clock = MAX_HOLD_MS;
    held.persistClient(cache('streaming'));
    expect(writes).toHaveLength(1);
  });
});
