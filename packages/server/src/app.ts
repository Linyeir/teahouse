import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { resolveToken } from './auth/tokens.ts';
import { CardError } from './cards/parse.ts';
import type { Db } from './db/index.ts';
import { Generator, type StreamFn } from './generation.ts';
import { Hub } from './hub.ts';
import { authRoutes } from './routes/auth.ts';
import { chatRoutes } from './routes/chats.ts';
import { HttpError, type Services } from './routes/context.ts';
import { profileRoutes } from './routes/profiles.ts';
import { settingsRoutes } from './routes/settings.ts';
import { worldRoutes } from './routes/worlds.ts';
import { wsRoutes } from './routes/ws.ts';
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
  /** Replaces the LLM call, for tests. */
  stream?: StreamFn;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({ db, worlds, clientDir, stream, logger = false }: AppOptions) {
  const app = Fastify({ logger });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('deviceId', '');

  const hub = new Hub();
  const services: Services = {
    db,
    hub,
    worlds,
    generator: new Generator(db, hub, worlds, stream),
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

  app.addHook('onClose', () => services.generator.stopAll());
  return app;
}
