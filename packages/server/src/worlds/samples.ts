import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isThemePreset, type SampleWorld } from '@teahouse/shared';
import type { Db } from '../db/index.ts';
import { installWorld } from './archive.ts';
import { parseDocument, stringifyDocument, stringValue } from './frontmatter.ts';
import type { WorldService } from './service.ts';

/** Sample worlds shipped with the server, one folder each (packages/server/samples). */
export const SAMPLES_DIR = join(import.meta.dirname, '../../samples');

export class SampleNotFoundError extends Error {}

export async function listSamples(dir = SAMPLES_DIR): Promise<SampleWorld[]> {
  const folders = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const samples: SampleWorld[] = [];
  for (const entry of folders) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(dir, entry.name, 'world.md'), 'utf8').catch(() => null);
    if (text === null) continue;
    const doc = parseDocument(text);
    if (doc.error) continue;
    samples.push({
      id: entry.name,
      name: stringValue(doc.data.name, entry.name),
      summary: stringValue(doc.data.summary),
      themePreset: isThemePreset(doc.data.themePreset) ? doc.data.themePreset : null,
    });
  }
  return samples.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Adds a sample world as a new, ordinary world. Every load is a separate copy with its own ID,
 * so it can be changed freely and loaded again from scratch.
 */
export async function installSample(db: Db, worlds: WorldService, id: string, dir = SAMPLES_DIR) {
  const sample = (await listSamples(dir)).find((s) => s.id === id);
  if (!sample) throw new SampleNotFoundError(id);
  const staging = await mkdtemp(join(tmpdir(), 'teahouse-sample-'));
  try {
    const worldDir = join(staging, 'world');
    await cp(join(dir, id), worldDir, { recursive: true });
    const worldPath = join(worldDir, 'world.md');
    const doc = parseDocument(await readFile(worldPath, 'utf8'));
    delete doc.data.id;
    await writeFile(worldPath, stringifyDocument(doc));
    return await installWorld(db, worlds, worldDir, sample.name, []);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
