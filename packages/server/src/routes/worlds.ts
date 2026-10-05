import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { canonPath, fileWrite, id, worldInput } from '@teahouse/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { importCard } from '../cards/import.ts';
import { assetFilePath } from '../worlds/paths.ts';
import { HttpError, type Services, typed } from './context.ts';

const params = z.object({ id });
const pathQuery = z.object({ path: canonPath });

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

const MAX_CARD_BYTES = 30 * 1024 * 1024;

export async function worldRoutes(app: FastifyInstance, { worlds }: Services) {
  const r = typed(app);

  r.get('/api/worlds', async () => worlds.list());

  r.post('/api/worlds', { schema: { body: worldInput } }, async ({ body }) =>
    worlds.create(body.name),
  );

  r.get('/api/worlds/:id/files', { schema: { params } }, async ({ params }) =>
    worlds.files(params.id),
  );

  r.get('/api/worlds/:id/file', { schema: { params, querystring: pathQuery } }, async (req) => ({
    path: req.query.path,
    content: await worlds.read(req.params.id, req.query.path),
  }));

  r.put('/api/worlds/:id/file', { schema: { params, body: fileWrite } }, async (req) => ({
    commit: await worlds.write(req.params.id, req.body.path, req.body.content),
  }));

  r.delete('/api/worlds/:id/file', { schema: { params, querystring: pathQuery } }, async (req) => ({
    commit: await worlds.remove(req.params.id, req.query.path),
  }));

  r.get(
    '/api/worlds/:id/history',
    { schema: { params, querystring: z.object({ path: canonPath.optional() }) } },
    async (req) => worlds.history(req.params.id, req.query.path),
  );

  r.get(
    '/api/worlds/:id/file-at',
    {
      schema: {
        params,
        querystring: pathQuery.extend({ sha: z.string().regex(/^[0-9a-f]{7,64}$/) }),
      },
    },
    async (req) => {
      try {
        return {
          path: req.query.path,
          content: await worlds.readAt(req.params.id, req.query.sha, req.query.path),
        };
      } catch {
        throw new HttpError(404, 'not_found', 'File not found in that version');
      }
    },
  );

  r.get('/api/worlds/:id/characters', { schema: { params } }, async ({ params }) =>
    worlds.characters(params.id),
  );

  // Images are requested by <img>, which cannot send headers: the token comes as `?token=`.
  r.get(
    '/api/worlds/:id/assets/*',
    { schema: { params: params.extend({ '*': z.string() }) } },
    async (req, reply) => {
      const dir = worlds.dir(await worlds.folder(req.params.id));
      const file = assetFilePath(dir, `assets/${req.params['*']}`);
      const type = IMAGE_TYPES[extname(file).toLowerCase()];
      const info = await stat(file).catch(() => null);
      if (!type || !info?.isFile()) throw new HttpError(404, 'not_found', 'Asset not found');
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      return reply.type(type).send(createReadStream(file));
    },
  );

  r.post('/api/import/card', async (req) => {
    const fields: Record<string, string> = {};
    let bytes: Buffer | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_CARD_BYTES, files: 1 } })) {
      if (part.type === 'file') bytes = await part.toBuffer();
      else if (typeof part.value === 'string') fields[part.fieldname] = part.value;
    }
    if (!bytes) throw new HttpError(400, 'invalid_request', 'No card file uploaded');
    const worldId = fields.worldId ? id.parse(fields.worldId) : undefined;
    if (worldId) await worlds.folder(worldId);
    return importCard(worlds, bytes, { worldId, newWorldName: fields.newWorldName?.trim() });
  });
}
