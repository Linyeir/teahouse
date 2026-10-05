import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { onTestFinished } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db/index.ts';
import type { StreamFn } from '../src/generation.ts';
import type { CompleteFn } from '../src/memory.ts';
import { WorldService } from '../src/worlds/service.ts';

/** A world service on a fresh temporary folder, removed after the test. */
export async function tempWorlds(): Promise<WorldService> {
  const root = await mkdtemp(join(tmpdir(), 'teahouse-worlds-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const worlds = new WorldService(root);
  await worlds.init();
  return worlds;
}

export async function createTestApp(stream?: StreamFn, complete?: CompleteFn) {
  const db = openDb(':memory:');
  const worlds = await tempWorlds();
  const app = await buildApp({ db, worlds, stream, complete });
  onTestFinished(() => app.close());
  await app.ready();
  const { token } = (
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      body: { password: 'correct horse', deviceName: 'test' },
    })
  ).json();
  const auth = { authorization: `Bearer ${token}` };
  const api = async <T = unknown>(method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: auth,
      body: body as object,
    });
    return { status: res.statusCode, body: res.json() as T };
  };
  return { app, db, worlds, token, api };
}

/** Minimal OpenAI-compatible server for adapter tests. */
export async function startMockEndpoint(
  options: { models?: object[]; props?: object; reply?: string[] } = {},
): Promise<{ server: FastifyInstance; baseUrl: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = Fastify();
  server.get('/v1/models', async () => ({
    object: 'list',
    data: options.models ?? [{ id: 'mock-model', object: 'model' }],
  }));
  if (options.props) server.get('/props', async () => options.props);
  server.post('/v1/chat/completions', async (req, reply) => {
    requests.push(req.body);
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const part of options.reply ?? ['Hello', ' there']) {
      const chunk = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'mock-model' };
      const choices = [{ index: 0, delta: { content: part }, finish_reason: null }];
      reply.raw.write(`data: ${JSON.stringify({ ...chunk, choices })}\n\n`);
    }
    reply.raw.end('data: [DONE]\n\n');
    return reply;
  });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  return { server, baseUrl: `${address}/v1`, requests };
}

export const profileBody = (baseUrl: string) => ({
  name: 'Mock',
  baseUrl,
  apiKey: 'secret-key',
  model: 'mock-model',
  temperature: 0.8,
  topP: null,
  maxTokens: null,
  contextWindowOverride: null,
});
