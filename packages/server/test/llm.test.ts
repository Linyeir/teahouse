import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { complete, extractJson, listModels, streamChat } from '../src/llm/client.ts';
import {
  contextFromLlamaProps,
  contextFromModelEntry,
  detectContextWindow,
} from '../src/llm/context-window.ts';
import { startMockEndpoint } from './helpers.ts';

const servers: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function mock(options: Parameters<typeof startMockEndpoint>[0]) {
  const endpoint = await startMockEndpoint(options);
  servers.push(endpoint.server);
  return endpoint;
}

const profile = (baseUrl: string) => ({
  baseUrl,
  apiKey: null,
  model: 'mock-model',
  temperature: 0.7,
  topP: null,
  maxTokens: 200,
});

describe('OpenAI-compatible adapter', () => {
  it('streams completion text and passes only the set parameters', async () => {
    const { baseUrl, requests } = await mock({ reply: ['Rain ', 'falls.'] });
    let text = '';
    for await (const delta of streamChat(
      profile(baseUrl),
      [{ role: 'user', content: 'Hi' }],
      new AbortController().signal,
    )) {
      text += delta;
    }
    expect(text).toBe('Rain falls.');
    expect(requests[0]).toMatchObject({ model: 'mock-model', temperature: 0.7, max_tokens: 200 });
    expect(requests[0]).not.toHaveProperty('top_p');
  });

  it('lists models', async () => {
    const { baseUrl } = await mock({ models: [{ id: 'b' }, { id: 'a' }] });
    expect(await listModels({ baseUrl, apiKey: null })).toEqual(['a', 'b']);
  });
});

describe('context window detection', () => {
  it('reads OpenRouter and LM Studio fields from the model listing', () => {
    expect(contextFromModelEntry({ id: 'x', context_length: 131072 })).toBe(131072);
    expect(
      contextFromModelEntry({ id: 'x', loaded_context_length: 8192, max_context_length: 32768 }),
    ).toBe(8192);
  });

  it('reads the slot context from llama.cpp /props', () => {
    expect(contextFromLlamaProps({ default_generation_settings: { n_ctx: 4096 } })).toBe(4096);
  });

  it('prefers the listing, then llama.cpp /props, then the trained maximum', async () => {
    const listed = await mock({ models: [{ id: 'mock-model', context_length: 16000 }] });
    expect(await detectContextWindow({ baseUrl: listed.baseUrl, apiKey: null }, 'mock-model')).toBe(
      16000,
    );

    const llama = await mock({
      models: [{ id: 'mock-model', meta: { n_ctx_train: 131072 } }],
      props: { default_generation_settings: { n_ctx: 4096 } },
    });
    expect(await detectContextWindow({ baseUrl: llama.baseUrl, apiKey: null }, 'mock-model')).toBe(
      4096,
    );

    const bare = await mock({ models: [{ id: 'mock-model', meta: { n_ctx_train: 131072 } }] });
    expect(await detectContextWindow({ baseUrl: bare.baseUrl, apiKey: null }, 'mock-model')).toBe(
      131072,
    );
  });
});

describe('structured output fallback', () => {
  it('falls back from json_schema to json_object to no format', async () => {
    const seen: (string | undefined)[] = [];
    const server = Fastify();
    servers.push(server);
    server.post('/v1/chat/completions', async (req, reply) => {
      const format = (req.body as { response_format?: { type: string } }).response_format?.type;
      seen.push(format);
      if (format === 'json_schema')
        return reply.code(400).send({ error: { message: 'json_schema not supported' } });
      return {
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: '{"ok":true}' },
          },
        ],
      };
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const text = await complete(
      { ...profile(`${address}/v1`), maxTokens: 100 },
      [{ role: 'user', content: 'Hi' }],
      { jsonSchema: { name: 'x', schema: { type: 'object' } }, minTokens: 500 },
    );
    expect(text).toBe('{"ok":true}');
    expect(seen).toEqual(['json_schema', 'json_object']);
  });

  it('retries with a larger budget when a reasoning model returns nothing', async () => {
    const limits: number[] = [];
    const server = Fastify();
    servers.push(server);
    server.post('/v1/chat/completions', async (req) => {
      const limit = (req.body as { max_tokens: number }).max_tokens;
      limits.push(limit);
      const content = limit < 1000 ? null : 'Tomas';
      return {
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          {
            index: 0,
            finish_reason: content ? 'stop' : 'length',
            message: { role: 'assistant', content },
          },
        ],
      };
    });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const text = await complete({ ...profile(`${address}/v1`), maxTokens: 200 }, [
      { role: 'user', content: 'Hi' },
    ]);
    expect(text).toBe('Tomas');
    expect(limits).toEqual([200, 4096]);
  });

  it('extracts JSON from fenced or chatty answers', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":{"b":2}} Hope that helps.')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json here')).toThrow();
  });
});
