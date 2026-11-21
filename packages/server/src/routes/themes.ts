import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PackageError } from '../packages/zip.ts';
import { MAX_THEME_BYTES } from '../themes/package.ts';
import { HttpError, notFound, type Services, typed } from './context.ts';

const params = z.object({ id: z.string() });

/** Uploaded themes (docs/theming.md, "Build your own theme"). */
export async function themeRoutes(app: FastifyInstance, { themes, hub }: Services) {
  const r = typed(app);

  r.get('/api/themes', async () => themes.list());

  r.get('/api/themes/:id/css', { schema: { params } }, async ({ params }) => {
    const css = await themes.css(params.id);
    if (css === null) throw notFound('Theme');
    return { css };
  });

  r.post('/api/themes', async (req) => {
    // The ZIP may be compressed well below the unpacked limit, never above it.
    const file = await req.file({ limits: { fileSize: MAX_THEME_BYTES } });
    if (!file) throw new HttpError(400, 'invalid_request', 'No theme package uploaded');
    const bytes = await file.toBuffer().catch(() => null);
    if (!bytes || file.file.truncated) {
      throw new HttpError(413, 'too-large', 'The theme package is larger than 50 MB');
    }
    try {
      const installed = await themes.install(bytes);
      hub.broadcast({ type: 'themes.changed' });
      return installed;
    } catch (err) {
      if (err instanceof PackageError) throw new HttpError(400, err.code, err.message);
      throw err;
    }
  });

  r.delete('/api/themes/:id', { schema: { params } }, async ({ params }) => {
    if (!(await themes.remove(params.id))) throw notFound('Theme');
    hub.broadcast({ type: 'themes.changed' });
    return { ok: true };
  });
}
