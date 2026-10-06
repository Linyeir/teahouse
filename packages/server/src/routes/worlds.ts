import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { canonPath, fileWrite, id, worldInput } from '@teahouse/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { importCard } from '../cards/import.ts';
import { assetFilePath } from '../worlds/paths.ts';
import { slug } from '../worlds/service.ts';
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
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const EXTENSION_BY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_TYPES).map(([ext, type]) => [type, ext === '.jpeg' ? '.jpg' : ext]),
);

/** Labels and IDs are short lowercase words, so models can write them in tags. */
const tagWord = (value: string | undefined, what: string) => {
  const word = slug(value ?? '', '');
  if (!word) throw new HttpError(400, 'invalid_request', `${what} is required`);
  return word.slice(0, 40);
};

/** Reads one uploaded image and the text fields of a multipart request. */
async function readImageUpload(req: FastifyRequest) {
  const fields: Record<string, string> = {};
  let file: { bytes: Buffer; extension: string } | null = null;
  for await (const part of req.parts({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } })) {
    if (part.type === 'file') {
      const extension =
        EXTENSION_BY_TYPE[part.mimetype] ??
        (IMAGE_TYPES[extname(part.filename).toLowerCase()]
          ? extname(part.filename).toLowerCase()
          : null);
      const bytes = await part.toBuffer();
      if (!extension)
        throw new HttpError(400, 'invalid_request', 'Upload a PNG, JPEG, WebP, GIF or AVIF image');
      if (part.file.truncated)
        throw new HttpError(413, 'too_large', 'The image is larger than 20 MB');
      file = { bytes, extension };
    } else if (typeof part.value === 'string') {
      fields[part.fieldname] = part.value;
    }
  }
  if (!file) throw new HttpError(400, 'invalid_request', 'No image uploaded');
  return { file, fields };
}

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

  const characterParams = params.extend({ slug: z.string().min(1).max(200) });

  r.post(
    '/api/worlds/:id/characters/:slug/images',
    { schema: { params: characterParams } },
    async (req) => {
      if (!(await worlds.character(req.params.id, req.params.slug))) {
        throw new HttpError(404, 'not_found', 'Character not found');
      }
      const { file, fields } = await readImageUpload(req);
      const label = tagWord(fields.label, 'A label');
      return worlds.setCharacterImage(
        req.params.id,
        req.params.slug,
        label,
        file.bytes,
        file.extension,
      );
    },
  );

  r.delete(
    '/api/worlds/:id/characters/:slug/images/:imageId',
    { schema: { params: characterParams.extend({ imageId: z.string().min(1) }) } },
    async ({ params }) => {
      await worlds.removeCharacterImage(params.id, params.slug, params.imageId);
      return { ok: true };
    },
  );

  r.get('/api/worlds/:id/backgrounds', { schema: { params } }, async ({ params }) =>
    worlds.backgrounds(params.id),
  );

  r.post('/api/worlds/:id/backgrounds', { schema: { params } }, async (req) => {
    await worlds.folder(req.params.id);
    const { file, fields } = await readImageUpload(req);
    const backgroundId = tagWord(fields.id || fields.description, 'A background name');
    const description = (fields.description ?? '').trim().slice(0, 300) || backgroundId;
    return worlds.setBackground(
      req.params.id,
      backgroundId,
      description,
      file.bytes,
      file.extension,
    );
  });

  r.delete(
    '/api/worlds/:id/backgrounds/:backgroundId',
    { schema: { params: params.extend({ backgroundId: z.string().min(1) }) } },
    async ({ params }) => {
      await worlds.removeBackground(params.id, params.backgroundId);
      return { ok: true };
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
