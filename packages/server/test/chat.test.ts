import type { ChatPath, Profile, ServerEvent } from '@teahouse/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamFn } from '../src/generation.ts';
import { createTestApp, profileBody, startMockEndpoint } from './helpers.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(stream: StreamFn) {
  const mock = await startMockEndpoint({ models: [{ id: 'mock-model', context_length: 8192 }] });
  const ctx = await createTestApp(stream);
  cleanups.push(
    () => mock.server.close(),
    () => ctx.app.close(),
  );
  const profile = await ctx.api<Profile>('POST', '/api/profiles', profileBody(mock.baseUrl));
  const character = await ctx.api<{ id: string }>('POST', '/api/characters', {
    name: 'Mira',
    description: '{{char}} is a smuggler who distrusts {{user}}.',
    firstMessage: 'Mira looks up. "You again."',
  });
  const chat = await ctx.api<ChatPath>('POST', '/api/chats', { characterId: character.body.id });
  return { ...ctx, profile: profile.body, chat: chat.body };
}

const echoStream: StreamFn = async function* (_profile, messages) {
  yield 'Saw ';
  yield `${messages.length} messages`;
};

describe('chat', () => {
  it('hides the API key and detects the context window', async () => {
    const { profile } = await setup(echoStream);
    expect(profile).not.toHaveProperty('apiKey');
    expect(profile.hasApiKey).toBe(true);
    expect(profile.detectedContextWindow).toBe(8192);
  });

  it('starts with the greeting and streams a reply over the WebSocket', async () => {
    const { app, api, token, chat } = await setup(echoStream);
    expect(chat.messages.map((m) => m.content)).toEqual(['Mira looks up. "You again."']);

    const ws = await app.injectWS(`/api/ws?token=${token}`);
    const events: ServerEvent[] = [];
    const finished = new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const event = JSON.parse(String(raw)) as ServerEvent;
        events.push(event);
        if (event.type === 'generation.finished') resolve();
      });
    });

    const sent = await api<{ messageId: string }>('POST', `/api/chats/${chat.chat.id}/messages`, {
      content: 'Hello, Mira.',
    });
    expect(sent.status).toBe(200);
    await finished;
    ws.terminate();

    const deltas = events.flatMap((e) => (e.type === 'generation.delta' ? [e.delta] : []));
    expect(deltas.join('')).toBe('Saw 3 messages'); // system, greeting, user

    const path = await api<ChatPath>('GET', `/api/chats/${chat.chat.id}`);
    expect(path.body.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ['assistant', 'Mira looks up. "You again."', 'complete'],
      ['user', 'Hello, Mira.', 'complete'],
      ['assistant', 'Saw 3 messages', 'complete'],
    ]);
  });

  it('renders {{char}} and {{user}} into the prompt', async () => {
    let captured = '';
    const { api, chat } = await setup(async function* (_p, messages) {
      captured = String(messages[0]?.content);
      yield 'ok';
    });
    await api('PUT', '/api/settings', {
      userName: 'Ash',
      outputLanguage: 'German',
      narratorProfileId: null,
    });
    await api('POST', `/api/chats/${chat.chat.id}/generate`);
    await waitFor(() => captured !== '');
    expect(captured).toContain('Mira is a smuggler who distrusts Ash.');
    expect(captured).toContain('Write in German.');
  });

  it('regenerates as a sibling and switches between siblings', async () => {
    let n = 0;
    const { api, chat } = await setup(async function* () {
      yield `reply ${++n}`;
    });
    const id = chat.chat.id;
    const first = await api<{ messageId: string }>('POST', `/api/chats/${id}/messages`, {
      content: 'Hi',
    });
    await waitForStatus(api, id, 'complete');
    await api('POST', `/api/messages/${first.body.messageId}/regenerate`);
    await waitForStatus(api, id, 'complete');

    let path = (await api<ChatPath>('GET', `/api/chats/${id}`)).body;
    const last = path.messages.at(-1);
    expect(last?.content).toBe('reply 2');
    expect(last?.siblingIds).toHaveLength(2);

    path = (
      await api<ChatPath>('POST', `/api/chats/${id}/leaf`, { messageId: first.body.messageId })
    ).body;
    expect(path.messages.at(-1)?.content).toBe('reply 1');
  });

  it('stops a running generation and keeps the partial text', async () => {
    let waiting = false;
    const { api, chat } = await setup(async function* (_p, _m, signal) {
      yield 'partial';
      waiting = true;
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
    });
    const id = chat.chat.id;
    const sent = await api<{ messageId: string }>('POST', `/api/chats/${id}/messages`, {
      content: 'Hi',
    });
    const busy = await api('POST', `/api/chats/${id}/messages`, { content: 'Again' });
    expect(busy.status).toBe(409);

    await waitFor(() => waiting);
    expect((await api('POST', `/api/messages/${sent.body.messageId}/stop`)).body).toEqual({
      stopped: true,
    });
    await waitForStatus(api, id, 'stopped');
    expect((await lastMessage(api, id))?.content).toBe('partial');
  });

  it('records endpoint errors on the message', async () => {
    const { api, chat } = await setup(async function* () {
      yield* [];
      throw new Error('model not loaded');
    });
    await api('POST', `/api/chats/${chat.chat.id}/messages`, { content: 'Hi' });
    await waitForStatus(api, chat.chat.id, 'error');
    expect((await lastMessage(api, chat.chat.id))?.error).toBe('model not loaded');
  });
});

type Api = Awaited<ReturnType<typeof setup>>['api'];

async function lastMessage(api: Api, chatId: string) {
  return (await api<ChatPath>('GET', `/api/chats/${chatId}`)).body.messages.at(-1);
}

async function waitForStatus(api: Api, chatId: string, status: string) {
  await waitFor(async () => (await lastMessage(api, chatId))?.status === status);
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for condition');
}
