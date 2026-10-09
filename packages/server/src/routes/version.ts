import { API_VERSION, type ServerVersion, TEAHOUSE_VERSION } from '@teahouse/shared';
import type { FastifyInstance } from 'fastify';
import { typed } from './context.ts';

export async function versionRoutes(app: FastifyInstance) {
  // Public: apps check it on the connect screen, before they have a token.
  typed(app).get(
    '/api/version',
    { config: { public: true } },
    async (): Promise<ServerVersion> => ({ version: TEAHOUSE_VERSION, api: API_VERSION }),
  );
}
