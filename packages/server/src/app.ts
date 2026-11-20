import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Pairing } from './auth/pairing.ts';
import { resolveToken } from './auth/tokens.ts';
import type { ToolsFn } from './canon/lookup.ts';
import { CanonProposals, ProposalError } from './canon/proposals.ts';
import { CardError } from './cards/parse.ts';
import type { Db } from './db/index.ts';
import { Generator, type StreamFn } from './generation.ts';
import { Hub } from './hub.ts';
import { complete } from './llm/client.ts';
import { ModelOutputError } from './llm/json.ts';
import { Memory } from './memory.ts';
import { recoverInterrupted } from './recover.ts';
import { NoProfileError } from './roles.ts';
import { authRoutes } from './routes/auth.ts';
import { chatRoutes } from './routes/chats.ts';
import { HttpError, type Services } from './routes/context.ts';
import { profileRoutes } from './routes/profiles.ts';
import { proposalRoutes } from './routes/proposals.ts';
import { settingsRoutes } from './routes/settings.ts';
import { syncRoutes } from './routes/sync.ts';
import { versionRoutes } from './routes/version.ts';
import { worldRoutes } from './routes/worlds.ts';
import { wsRoutes } from './routes/ws.ts';
import { SceneError, Scenes } from './scenes.ts';
import { PathError } from './worlds/paths.ts';
import { WorldNotFoundError, type WorldService } from './worlds/service.ts';

declare module 'fastify' {
  interface FastifyRequest {
    deviceId: string;
  }
  interface FastifyInstance {
    /** Every route with its methods and whether it is public, for the perimeter tests. */
    routeTable: { method: string | string[]; url: string; public: boolean }[];
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
  /** Tool calls of the canon lookups; null turns them off. */
  tools?: ToolsFn | null;
  logger?: FastifyServerOptions['logger'];
  /** Extra origins allowed to call the API from a browser, besides the Tauri apps. */
  corsOrigins?: string[];
}

/** Whether a route pattern (not a request URL) belongs to the API and so needs a device token. */
export function isApiRoute(pattern: string | undefined): boolean {
  return pattern !== undefined && (pattern === '/api' || pattern.startsWith('/api/'));
}

/** Routes @fastify/static registers for the client files. */
const STATIC_ROUTES = new Set(['/*', '/']);

/** Origins of the Tauri webviews: macOS and Linux, then Windows and Android. */
const APP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

export async function buildApp({
  db,
  worlds,
  clientDir,
  stream,
  complete: completeFn,
  tools,
  logger = false,
  corsOrigins = [],
}: AppOptions) {
  const app = Fastify({ logger });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // The apps load the client from their own origin and talk to the server cross-origin.
  // Auth is a bearer token, not a cookie, so allowing these origins exposes nothing extra.
  await app.register(fastifyCors, {
    origin: [...APP_ORIGINS, ...corsOrigins],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    exposedHeaders: ['content-disposition'],
    maxAge: 600,
  });
  app.decorateRequest('deviceId', '');
  // Default deny: a route outside /api/ would skip the token check below, so it must say
  // that it is public. Only the static client files are exempt.
  app.decorate('routeTable', []);
  app.addHook('onRoute', (route) => {
    app.routeTable.push({
      method: route.method,
      url: route.url,
      public: route.config?.public === true,
    });
    if (isApiRoute(route.url) || route.config?.public || STATIC_ROUTES.has(route.url)) return;
    throw new Error(`Route ${route.url} is outside /api/ and not marked public`);
  });

  // Nothing runs yet: whatever the database says is running was cut off by a crash or stop.
  const recovered = recoverInterrupted(db);
  if (recovered.messages || recovered.proposals) {
    app.log.warn(recovered, 'Settled replies and canon proposals cut off by the last stop');
  }

  const hub = new Hub();
  const memory = new Memory(db, worlds, completeFn ?? complete, (err) =>
    app.log.warn({ err }, 'Active Memory summary failed'),
  );
  const generator = new Generator(db, hub, worlds, memory, stream, app.log);
  const proposals = new CanonProposals({
    db,
    worlds,
    hub,
    complete: completeFn,
    tools,
    log: app.log,
  });
  const services: Services = {
    db,
    hub,
    worlds,
    memory,
    generator,
    proposals,
    pairing: new Pairing(),
    scenes: new Scenes(db, worlds, hub, generator, proposals, completeFn),
  };

  app.addHook('onRequest', async (req, reply) => {
    // Decide on the route Fastify matched, never on the raw URL: the router decodes the path
    // (`/%61pi/devices` reaches `/api/devices`), a string test on `req.url` does not. Every API
    // route needs a device token unless it is marked public; requests that match no API route
    // (static files, the app shell, 404s) never reach a handler that reads data.
    if (!isApiRoute(req.routeOptions.url) || req.routeOptions.config?.public) return;
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
    syncRoutes,
    versionRoutes,
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
    await Promise.all([generator.stopAll(), proposals.stopAll()]);
    await memory.idle();
  });
  return app;
}
