import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../db/index.ts';
import type { Generator } from '../generation.ts';
import type { Hub } from '../hub.ts';

export interface Services {
  db: Db;
  hub: Hub;
  generator: Generator;
}

export const typed = (app: FastifyInstance) => app.withTypeProvider<ZodTypeProvider>();

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
