import type { ChatPath, Message, ServerEvent } from '@teahouse/shared';

/**
 * Text of replies that are still streaming, kept outside the query cache. A refetch can return
 * an older state than what was already streamed (the server persists only periodically), and
 * deltas can arrive before the cached path contains their message.
 */
export class StreamBuffers {
  readonly #texts = new Map<string, string>();

  get(messageId: string): string | undefined {
    return this.#texts.get(messageId);
  }

  /** Feeds an event in. Returns the full text for deltas, or `null` when deltas were missed. */
  apply(event: ServerEvent, cached?: string): string | null | undefined {
    if (event.type === 'generation.started') this.#texts.set(event.message.id, '');
    if (event.type === 'generation.finished') this.#texts.delete(event.message.id);
    if (event.type !== 'generation.delta') return undefined;

    // Joined mid-stream (e.g. another device started it): continue from the cached text.
    const text = this.#texts.get(event.messageId) ?? cached;
    if (text === undefined || event.offset > text.length) return null;
    const next = text + event.delta.slice(text.length - event.offset);
    this.#texts.set(event.messageId, next);
    return next;
  }
}

/** A change to a cached chat path, derived from a server event. */
export type PathUpdate =
  | { type: 'started'; message: Message }
  | { type: 'content'; messageId: string; content: string }
  | { type: 'finished'; message: Message };

/** Applies an update. Returns `null` when the path has to be refetched instead. */
export function applyUpdate(path: ChatPath, update: PathUpdate): ChatPath | null {
  if (update.type === 'started') {
    const { message } = update;
    if (message.chatId !== path.chat.id) return path;
    const parentIndex = path.messages.findIndex((m) => m.id === message.parentId);
    if (message.parentId !== null && parentIndex === -1) return null;
    const previousSiblings = path.messages[parentIndex + 1]?.siblingIds ?? [];
    return {
      ...path,
      chat: { ...path.chat, activeLeafId: message.id },
      messages: [
        ...path.messages.slice(0, parentIndex + 1),
        { ...message, siblingIds: [...previousSiblings, message.id] },
      ],
    };
  }

  const id = update.type === 'content' ? update.messageId : update.message.id;
  const index = path.messages.findIndex((m) => m.id === id);
  const current = path.messages[index];
  if (!current) return path;
  const messages = [...path.messages];
  messages[index] =
    update.type === 'content'
      ? { ...current, content: update.content }
      : { ...current, ...update.message };
  return { ...path, messages };
}

/** Puts streamed text that is ahead of the fetched state back into a fetched path. */
export function mergeFetched(fetched: ChatPath, buffers: StreamBuffers): ChatPath {
  return {
    ...fetched,
    messages: fetched.messages.map((m) => {
      const streamed = m.status === 'streaming' ? buffers.get(m.id) : undefined;
      return streamed !== undefined && streamed.length > m.content.length
        ? { ...m, content: streamed }
        : m;
    }),
  };
}

/** Text streamed over the WebSocket, shared by the event handler and chat fetches. */
export const streamBuffers = new StreamBuffers();
