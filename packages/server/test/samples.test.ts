import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  CharacterSummary,
  InstalledWorld,
  SampleWorld,
  World,
  WorldBackground,
} from '@teahouse/shared';
import { describe, expect, it } from 'vitest';
import type { StreamFn } from '../src/generation.ts';
import { SAMPLES_DIR } from '../src/worlds/samples.ts';
import { createTestApp } from './helpers.ts';

const stream: StreamFn = async function* () {
  yield '';
};

describe('sample worlds', () => {
  it('lists the shipped samples with their themes', async () => {
    const ctx = await createTestApp(stream);
    const samples = (await ctx.api<SampleWorld[]>('GET', '/api/samples')).body;
    expect(samples.map((s) => [s.id, s.themePreset])).toEqual([
      ['haru-no-yado', 'sakura'],
      ['ironbay', 'halftone'],
      ['mossbrook-wood', 'picturebook'],
    ]);
    expect(samples.every((s) => s.summary.length > 0)).toBe(true);
  });

  it('loads a sample as an ordinary world with characters, images and backgrounds', async () => {
    const ctx = await createTestApp(stream);
    const res = await ctx.api<InstalledWorld>('POST', '/api/samples/ironbay');
    expect(res.status).toBe(200);
    const world = (await ctx.api<World[]>('GET', '/api/worlds')).body.find(
      (w) => w.id === res.body.worldId,
    );
    expect(world).toMatchObject({ name: 'Ironbay', themePreset: 'halftone' });

    const characters = (
      await ctx.api<CharacterSummary[]>('GET', `/api/worlds/${res.body.worldId}/characters`)
    ).body;
    expect(characters.map((c) => c.slug).sort()).toEqual(['gearwright', 'sparrow']);
    for (const c of characters) {
      expect(c.images.map((i) => i.label).sort()).toEqual(['amused', 'angry', 'neutral', 'sad']);
    }
    const backgrounds = (
      await ctx.api<WorldBackground[]>('GET', `/api/worlds/${res.body.worldId}/backgrounds`)
    ).body;
    expect(backgrounds.map((b) => b.id).sort()).toEqual(['lair', 'newsroom', 'rooftop']);

    // The image files came along.
    const dir = ctx.worlds.dir(res.body.folder);
    expect((await stat(join(dir, 'assets/characters/sparrow/neutral.webp'))).size).toBeGreaterThan(
      0,
    );
  });

  it('loads a second copy as a separate world', async () => {
    const ctx = await createTestApp(stream);
    const a = (await ctx.api<InstalledWorld>('POST', '/api/samples/haru-no-yado')).body;
    const b = (await ctx.api<InstalledWorld>('POST', '/api/samples/haru-no-yado')).body;
    expect(b.worldId).not.toBe(a.worldId);
    expect(b.folder).not.toBe(a.folder);
    expect((await ctx.api<World[]>('GET', '/api/worlds')).body).toHaveLength(2);
  });

  // The sample folders carry the `.gitignore` of a world, which ignores `assets/`: images must be
  // added with `git add -f`, or they exist on one machine only.
  it('ships every image a sample refers to in Git', async () => {
    const files: string[] = [];
    for (const sample of await readdir(SAMPLES_DIR, { recursive: true })) {
      if (!sample.endsWith('.md')) continue;
      const text = await readFile(join(SAMPLES_DIR, sample), 'utf8');
      const world = sample.split(sep)[0] ?? '';
      for (const m of text.matchAll(/^\s*file: (assets\/\S+)$/gm)) {
        if (m[1]) files.push(join(SAMPLES_DIR, world, m[1]));
      }
    }
    expect(files.length).toBeGreaterThan(30);
    const tracked = execFileSync('git', ['ls-files', '--', ...files], {
      cwd: SAMPLES_DIR,
      encoding: 'utf8',
    });
    const lines = new Set(tracked.split('\n'));
    const missing = files.filter((f) => !lines.has(relative(SAMPLES_DIR, f)));
    expect(missing).toEqual([]);
  });

  it('answers 404 for an unknown sample', async () => {
    const ctx = await createTestApp(stream);
    expect((await ctx.api('POST', '/api/samples/nowhere')).status).toBe(404);
    expect((await ctx.api('POST', '/api/samples/..')).status).toBe(404);
  });
});
