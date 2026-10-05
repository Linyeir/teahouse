import { id, proposalFileUpdate } from '@teahouse/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { scenes } from '../db/schema.ts';
import { HttpError, notFound, type Services, typed } from './context.ts';

const params = z.object({ id });

export async function proposalRoutes(app: FastifyInstance, { db, proposals }: Services) {
  const r = typed(app);

  const closingScene = (sceneId: string) => {
    const scene = db.select().from(scenes).where(eq(scenes.id, sceneId)).get();
    if (!scene) throw notFound('Scene');
    return scene;
  };

  r.get('/api/scenes/:id/proposal', { schema: { params } }, async ({ params }) => {
    closingScene(params.id);
    return proposals.get(params.id);
  });

  r.put(
    '/api/scenes/:id/proposal/file',
    { schema: { params, body: proposalFileUpdate } },
    async ({ params, body }) => proposals.decide(params.id, body.path, body.decision, body.after),
  );

  r.post('/api/scenes/:id/proposal/regenerate', { schema: { params } }, async ({ params }) => {
    if (closingScene(params.id).status !== 'closing') {
      throw new HttpError(409, 'conflict', 'The scene is not waiting for canon');
    }
    proposals.start(params.id);
    return proposals.get(params.id);
  });

  r.post('/api/scenes/:id/proposal/apply', { schema: { params } }, async ({ params }) => {
    if (closingScene(params.id).status !== 'closing') {
      throw new HttpError(409, 'conflict', 'The scene is not waiting for canon');
    }
    const result = await proposals.apply(params.id);
    if (result.conflicts.length > 0) {
      throw new HttpError(
        409,
        'merge_conflict',
        `Changed since the proposal: ${result.conflicts.join(', ')}. Resolve the conflicts and accept again.`,
      );
    }
    return result;
  });
}
