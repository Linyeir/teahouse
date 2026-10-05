import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { resolveToken } from './auth/tokens.ts';
import { CanonProposals, ProposalError } from './canon/proposals.ts';
import { CardError } from './cards/parse.ts';
import type { Db } from './db/index.ts';
import { Generator, type StreamFn } from './generation.ts';
import { Hub } from './hub.ts';
import { complete } from './llm/client.ts';
import { ModelOutputError } from './llm/json.ts';
import { Memory } from './memory.ts';
import { NoProfileError } from './roles.ts';
import { authRoutes } from './routes/auth.ts';
import { chatRoutes } from './routes/chats.ts';
import { HttpError, type Services } from './routes/context.ts';
import { profileRoutes } from './routes/profiles.ts';
import { proposalRoutes } from './routes/proposals.ts';
import { settingsRoutes } from './routes/settings.ts';
import { worldRoutes } from './routes/worlds.ts';
import { wsRoutes } from './routes/ws.ts';
import { SceneError, Scenes } from './scenes.ts';
import { PathError } from './worlds/paths.ts';
import { WorldNotFoundError, type WorldService } from './worlds/service.ts';

declare module 'fastify' {
  interface FastifyRequest {
    deviceId: string;
  }
  interface FastifyContextConfig {
    /** Route is reachable without a device token. */
    public?: boolean;
  }
}

export interface AppOptions {
  db: Db;
  worlds: WorldService;
  clientDir?: string | null;
  /** Replace the LLM calls, for tests. */
  stream?: StreamFn;
  complete?: typeof complete;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({
  db,
  worlds,
  clientDir,
  stream,
  complete: completeFn,
  logger = false,
}: AppOptions) {
  const app = Fastify({ logger });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('deviceId', '');

  const hub = new Hub();
  const memory = new Memory(db, worlds, completeFn ?? complete, (err) =>
    app.log.warn({ err }, 'Active Memory summary failed'),
  );
  const generator = new Generator(db, hub, worlds, memory, stream);
  const proposals = new CanonProposals({ db, worlds, hub, complete: completeFn });
  const services: Services = {
    db,
    hub,
    worlds,
    memory,
    generator,
    proposals,
    scenes: new Scenes(db, worlds, hub, generator, proposals, completeFn),
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.routeOptions.config?.public) return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : new URL(req.url, 'http://local').searchParams.get('token');
    const deviceId = token ? resolveToken(db, token) : null;
    if (!deviceId) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Login required' });
    }
    req.deviceId = deviceId;
  });

  app.setErrorHandler((err: FastifyError | HttpError, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof WorldNotFoundError) {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
    if (err instanceof SceneError) {
      const status = { not_found: 404, conflict: 409, invalid: 400 }[err.code];
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ProposalError) {
      return reply.code(409).send({ error: 'conflict', message: err.message });
    }
    if (err instanceof ModelOutputError) {
      return reply.code(502).send({ error: 'bad_model_output', message: err.message });
    }
    if (err instanceof NoProfileError) {
      return reply.code(409).send({ error: 'no_profile', message: err.message });
    }
    if (err instanceof PathError || err instanceof CardError) {
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return reply.code(404).send({ error: 'not_found', message: 'File not found' });
    }
    if ('validation' in err && err.validation) {
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: 'rate_limited', message: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Internal server error' });
  });

  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart);
  for (const routes of [
    authRoutes,
    profileRoutes,
    worldRoutes,
    chatRoutes,
    proposalRoutes,
    settingsRoutes,
    wsRoutes,
  ]) {
    await app.register(routes, services);
  }

  if (clientDir) {
    await app.register(fastifyStatic, { root: clientDir });
    // Client-side routing: unknown non-API paths get the app shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found', message: 'Route not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    await generator.stopAll();
    await Promise.all([memory.idle(), proposals.idle()]);
  });
  return app;
}
