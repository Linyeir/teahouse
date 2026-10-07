import type { ChatPath, Message } from '@teahouse/shared';
import { describe, expect, it } from 'vitest';
import { applyUpdate, mergeFetched, StreamBuffers } from './chat-state.ts';

const msg = (id: string, parentId: string | null, content = ''): Message => ({
  id,
  chatId: 'c',
  parentId,
  role: 'assistant',
  content,
  status: 'complete',
  error: null,
  createdAt: '',
  updatedAt: '',
  revision: 1,
});

const path: ChatPath = {
  chat: { id: 'c', title: 'T', worldId: 'w', characterSlug: 'x', activeLeafId: 'b', updatedAt: '' },
  scene: null,
  memory: [],
  closedScenes: [],
  messages: [
    { ...msg('a', null, 'hi'), siblingIds: ['a'] },
    { ...msg('b', 'a', 'old'), siblingIds: ['b'] },
  ],
};

const delta = (offset: number, text: string) =>
  ({ type: 'generation.delta', chatId: 'c', messageId: 'm', offset, delta: text }) as const;

describe('StreamBuffers', () => {
  it('accumulates deltas and ignores text it already has', () => {
    const buffers = new StreamBuffers();
    buffers.apply({ type: 'generation.started', chatId: 'c', message: msg('m', 'a') });
    expect(buffers.apply(delta(0, 'Mira '))).toBe('Mira ');
    expect(buffers.apply(delta(5, 'sets'))).toBe('Mira sets');
    expect(buffers.apply(delta(2, 'ra sets'))).toBe('Mira sets');
  });

  it('reports gaps and continues from cached text when joining mid-stream', () => {
    const buffers = new StreamBuffers();
    expect(buffers.apply(delta(3, 'x'))).toBeNull();
    expect(buffers.apply(delta(3, ' more'), 'old')).toBe('old more');
  });

  it('puts streamed text back into an older fetched state', () => {
    const buffers = new StreamBuffers();
    buffers.apply({ type: 'generation.started', chatId: 'c', message: msg('b', 'a') });
    buffers.apply({ ...delta(0, 'old and more'), messageId: 'b' });
    const fetched: ChatPath = {
      ...path,
      messages: path.messages.map((m) => (m.id === 'b' ? { ...m, status: 'streaming' } : m)),
    };
    expect(mergeFetched(fetched, buffers).messages[1]?.content).toBe('old and more');
  });
});

describe('applyUpdate', () => {
  it('replaces the tail with a regenerated sibling', () => {
    const next = applyUpdate(path, {
      type: 'started',
      message: { ...msg('b2', 'a'), status: 'streaming' },
    });
    expect(next?.messages.map((m) => m.id)).toEqual(['a', 'b2']);
    expect(next?.messages[1]?.siblingIds).toEqual(['b', 'b2']);
  });

  it('sets streamed content', () => {
    const next = applyUpdate(path, { type: 'content', messageId: 'b', content: 'old more' });
    expect(next?.messages[1]?.content).toBe('old more');
  });

  it('asks for a refetch when the parent is unknown', () => {
    expect(applyUpdate(path, { type: 'started', message: msg('n', 'missing') })).toBeNull();
  });
});
