import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

export class PathError extends Error {}

/** Folders and files Teahouse never reads or writes as canon. */
const RESERVED = new Set(['.git', '.obsidian', 'assets']);

/**
 * Resolves a world-relative path and makes sure it stays inside the world.
 * Canon paths must be Markdown files outside `.git`, `.obsidian` and `assets`.
 */
export function canonFilePath(worldDir: string, path: string): string {
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  const first = normalized.split('/')[0] ?? '';
  if (isAbsolute(path) || normalized.startsWith('..') || RESERVED.has(first)) {
    throw new PathError(`Invalid canon path: ${path}`);
  }
  if (!normalized.endsWith('.md')) throw new PathError('Canon files must be .md files');
  return insideWorld(worldDir, normalized);
}

/** Resolves a path below the world's `assets/` folder. */
export function assetFilePath(worldDir: string, path: string): string {
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  if (!normalized.startsWith('assets/')) throw new PathError(`Not an asset path: ${path}`);
  return insideWorld(worldDir, normalized);
}

function insideWorld(worldDir: string, normalized: string): string {
  const full = resolve(worldDir, normalized);
  const rel = relative(worldDir, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new PathError(`Path leaves the world folder: ${normalized}`);
  }
  return full;
}

export const isIgnoredForCanon = (rel: string): boolean => {
  const parts = rel.split(/[\\/]/);
  return parts.some((p) => RESERVED.has(p) || (p.startsWith('.') && p !== '.gitignore'));
};
