import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import slugify from '@sindresorhus/slugify';
import {
  type CanonFile,
  type CharacterImage,
  type CharacterSummary,
  sanitizeTheme,
  type World,
} from '@teahouse/shared';
import { newId } from '../time.ts';
import { parseDocument, stringifyDocument, stringList, stringValue } from './frontmatter.ts';
import { canonFilePath, isIgnoredForCanon, PathError } from './paths.ts';
import { type CommitInfo, WorldRepo } from './repo.ts';

export class WorldNotFoundError extends Error {}

export interface WorldBackground {
  id: string;
  file: string;
  description: string;
}

/** Entries of an image list in frontmatter (`images`, `backgrounds`) that have id and file. */
function parseImages(value: unknown): (Record<string, unknown> & { id: string; file: string })[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> & { id: string; file: string } =>
      Boolean(v) && typeof v === 'object' && typeof v.id === 'string' && typeof v.file === 'string',
  );
}

const CANON_DIRS = ['characters', 'places', 'events', 'lore'];

const GITIGNORE = 'assets/\n.obsidian/\n';

export const slug = (text: string, fallback = 'untitled') => slugify(text) || fallback;

/** Worlds are folders under `root`; each holds Markdown canon files and its own Git repo. */
export class WorldService {
  readonly #repos = new Map<string, WorldRepo>();
  /** World ID → folder name. Rebuilt by scanning, since folders can be added by hand. */
  #folders = new Map<string, string>();

  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.list();
  }

  dir(folder: string): string {
    return join(this.root, folder);
  }

  repo(folder: string): WorldRepo {
    let repo = this.#repos.get(folder);
    if (!repo) {
      repo = new WorldRepo(this.dir(folder));
      this.#repos.set(folder, repo);
    }
    return repo;
  }

  async list(): Promise<World[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const worlds: World[] = [];
    const folders = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const world = await this.#readWorld(entry.name);
      if (!world) continue;
      folders.set(world.id, world.folder);
      worlds.push(world);
    }
    this.#folders = folders;
    return worlds.sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(name: string): Promise<World> {
    const folder = await this.#uniqueFolder(slug(name, 'world'));
    const dir = this.dir(folder);
    const id = newId();
    await mkdir(dir, { recursive: true });
    for (const sub of [...CANON_DIRS, 'assets']) await mkdir(join(dir, sub), { recursive: true });
    for (const sub of CANON_DIRS) await writeFile(join(dir, sub, '.gitkeep'), '');
    await writeFile(join(dir, '.gitignore'), GITIGNORE);
    await writeFile(
      join(dir, 'world.md'),
      stringifyDocument({
        data: { id, type: 'world', name, tags: [], aliases: [], summary: '' },
        body: `# ${name}\n\nGround rules, tone and setting of this world.`,
      }),
    );
    await writeFile(
      join(dir, 'user.md'),
      stringifyDocument({
        data: { type: 'user', tags: [], aliases: [], summary: '' },
        body: '# {{user}}\n\nWhat this world knows about {{user}}.',
      }),
    );
    const repo = this.repo(folder);
    await repo.ensure();
    await repo.commitAll(`Create world ${name}`);
    this.#folders.set(id, folder);
    return { id, name, folder, summary: '', theme: {} };
  }

  /** Folder of a world, rescanning once if the ID is unknown. */
  async folder(worldId: string): Promise<string> {
    if (!this.#folders.has(worldId)) await this.list();
    const folder = this.#folders.get(worldId);
    if (!folder) throw new WorldNotFoundError(`World ${worldId} not found`);
    return folder;
  }

  async get(worldId: string): Promise<World> {
    const world = await this.#readWorld(await this.folder(worldId));
    if (!world) throw new WorldNotFoundError(`World ${worldId} not found`);
    return world;
  }

  async files(worldId: string): Promise<CanonFile[]> {
    const dir = this.dir(await this.folder(worldId));
    const paths = (await readdir(dir, { recursive: true }))
      .map((p) => p.split(/[\\/]/).join('/'))
      .filter((p) => p.endsWith('.md') && !isIgnoredForCanon(p))
      .sort();
    return Promise.all(
      paths.map(async (path) => {
        const doc = parseDocument(await readFile(join(dir, path), 'utf8'));
        return {
          path,
          type: typeof doc.data.type === 'string' ? doc.data.type : null,
          name: stringValue(doc.data.name, posix.basename(path, '.md')),
          summary: stringValue(doc.data.summary),
          tags: stringList(doc.data.tags),
          aliases: stringList(doc.data.aliases),
          error: doc.error ?? null,
        };
      }),
    );
  }

  async read(worldId: string, path: string): Promise<string> {
    return readFile(canonFilePath(this.dir(await this.folder(worldId)), path), 'utf8');
  }

  /** Reads a canon file, or null if it does not exist. */
  async readIfExists(worldId: string, path: string): Promise<string | null> {
    try {
      return await this.read(worldId, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Writes one canon file and commits it. Returns the commit, or null if nothing changed. */
  async write(worldId: string, path: string, content: string, message?: string) {
    const folder = await this.folder(worldId);
    const full = canonFilePath(this.dir(folder), path);
    const repo = this.repo(folder);
    return repo.run(async () => {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
      return repo.commitNow(message ?? `Edit ${path}`);
    });
  }

  async remove(worldId: string, path: string): Promise<string | null> {
    const folder = await this.folder(worldId);
    const full = canonFilePath(this.dir(folder), path);
    if (path === 'world.md') throw new Error('world.md cannot be deleted');
    const repo = this.repo(folder);
    return repo.run(async () => {
      await rm(full);
      return repo.commitNow(`Delete ${path}`);
    });
  }

  /**
   * Runs `task` with exclusive access to the world folder and commits everything it changed in
   * one commit. Used for imports that touch several files.
   */
  async transaction(
    worldId: string,
    message: string,
    task: (dir: string) => Promise<void>,
  ): Promise<string | null> {
    const folder = await this.folder(worldId);
    const repo = this.repo(folder);
    return repo.run(async () => {
      await task(this.dir(folder));
      return repo.commitNow(message);
    });
  }

  async history(worldId: string, path?: string): Promise<CommitInfo[]> {
    const folder = await this.folder(worldId);
    if (path) canonFilePath(this.dir(folder), path);
    return this.repo(folder).log(path);
  }

  async readAt(worldId: string, sha: string, path: string): Promise<string> {
    const folder = await this.folder(worldId);
    canonFilePath(this.dir(folder), path);
    return this.repo(folder).show(sha, path);
  }

  async characters(worldId: string): Promise<CharacterSummary[]> {
    const files = (await this.files(worldId)).filter(
      (f) => f.type === 'character' || (f.type === null && f.path.startsWith('characters/')),
    );
    const result: CharacterSummary[] = [];
    for (const file of files) {
      const character = await this.character(worldId, posix.basename(file.path, '.md'));
      if (character) result.push(character.summary);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Backgrounds of the world, from `backgrounds` in the frontmatter of `world.md`. */
  async backgrounds(worldId: string): Promise<WorldBackground[]> {
    const doc = parseDocument((await this.readIfExists(worldId, 'world.md')) ?? '');
    return parseImages(doc.data.backgrounds).map((b) => ({
      id: b.id,
      file: b.file,
      description: stringValue(b.description),
    }));
  }

  /**
   * Stores an image for a character and lists it in the character's frontmatter. An existing
   * image with the same label is replaced. Images live in `assets/` (not in Git); the
   * frontmatter change is committed.
   */
  async setCharacterImage(
    worldId: string,
    characterSlug: string,
    label: string,
    bytes: Uint8Array,
    extension: string,
  ): Promise<CharacterImage> {
    const path = `characters/${characterSlug}.md`;
    const id = newId();
    const image = { id, label, file: `assets/characters/${characterSlug}/${id}${extension}` };
    await this.#editFrontmatter(
      worldId,
      path,
      `Set image "${label}" of ${characterSlug}`,
      async (data, dir) => {
        const images = parseImages(data.images);
        for (const old of images.filter((i) => i.label === label))
          await rm(join(dir, old.file), { force: true });
        await mkdir(dirname(join(dir, image.file)), { recursive: true });
        await writeFile(join(dir, image.file), bytes);
        data.images = [...images.filter((i) => i.label !== label), image];
      },
    );
    return image;
  }

  async removeCharacterImage(
    worldId: string,
    characterSlug: string,
    imageId: string,
  ): Promise<void> {
    await this.#editFrontmatter(
      worldId,
      `characters/${characterSlug}.md`,
      `Remove an image of ${characterSlug}`,
      async (data, dir) => {
        const images = parseImages(data.images);
        const target = images.find((i) => i.id === imageId);
        if (!target) throw new WorldNotFoundError('Image not found');
        await rm(join(dir, target.file), { force: true });
        data.images = images.filter((i) => i.id !== imageId);
      },
    );
  }

  /** Stores a background and lists it in `world.md`. An existing one with the same ID is replaced. */
  async setBackground(
    worldId: string,
    id: string,
    description: string,
    bytes: Uint8Array,
    extension: string,
  ): Promise<WorldBackground> {
    const background = { id, description, file: `assets/backgrounds/${id}-${newId()}${extension}` };
    await this.#editFrontmatter(worldId, 'world.md', `Set background ${id}`, async (data, dir) => {
      const backgrounds = parseImages(data.backgrounds);
      for (const old of backgrounds.filter((b) => b.id === id))
        await rm(join(dir, old.file), { force: true });
      await mkdir(dirname(join(dir, background.file)), { recursive: true });
      await writeFile(join(dir, background.file), bytes);
      data.backgrounds = [...backgrounds.filter((b) => b.id !== id), background];
    });
    return background;
  }

  async removeBackground(worldId: string, id: string): Promise<void> {
    await this.#editFrontmatter(
      worldId,
      'world.md',
      `Remove background ${id}`,
      async (data, dir) => {
        const backgrounds = parseImages(data.backgrounds);
        const target = backgrounds.find((b) => b.id === id);
        if (!target) throw new WorldNotFoundError('Background not found');
        await rm(join(dir, target.file), { force: true });
        data.backgrounds = backgrounds.filter((b) => b.id !== id);
      },
    );
  }

  /** Changes a file's frontmatter (and assets) in one queued, committed operation. */
  async #editFrontmatter(
    worldId: string,
    path: string,
    message: string,
    edit: (data: Record<string, unknown>, dir: string) => Promise<void>,
  ): Promise<void> {
    await this.transaction(worldId, message, async (dir) => {
      const full = canonFilePath(dir, path);
      const doc = parseDocument(await readFile(full, 'utf8'));
      if (doc.error) throw new PathError(`${path} has invalid frontmatter: ${doc.error}`);
      await edit(doc.data, dir);
      await writeFile(full, stringifyDocument(doc));
    });
  }

  /** A character by file slug (`characters/<slug>.md`). */
  async character(worldId: string, characterSlug: string) {
    const path = `characters/${characterSlug}.md`;
    const text = await this.readIfExists(worldId, path);
    if (text === null) return null;
    const doc = parseDocument(text);
    const images = Array.isArray(doc.data.images)
      ? doc.data.images.flatMap((img): CharacterImage[] =>
          img &&
          typeof img === 'object' &&
          typeof img.id === 'string' &&
          typeof img.file === 'string'
            ? [{ id: img.id, file: img.file, label: stringValue(img.label, 'neutral') }]
            : [],
        )
      : [];
    const summary: CharacterSummary = {
      slug: characterSlug,
      path,
      name: stringValue(doc.data.name, characterSlug),
      summary: stringValue(doc.data.summary),
      greetings: stringList(doc.data.greetings),
      images,
    };
    return { summary, body: doc.body };
  }

  /** Free file name in `dir` (relative to the world) for `base`, e.g. `mira-2.md`. */
  async uniquePath(worldDir: string, dir: string, base: string): Promise<string> {
    for (let n = 1; ; n++) {
      const path = `${dir}/${n === 1 ? base : `${base}-${n}`}.md`;
      if (!existsSync(join(worldDir, path))) return path;
    }
  }

  async #uniqueFolder(base: string): Promise<string> {
    for (let n = 1; ; n++) {
      const folder = n === 1 ? base : `${base}-${n}`;
      if (!existsSync(this.dir(folder))) return folder;
    }
  }

  /** Reads `world.md`; gives the world an ID if it has none (e.g. a hand-made folder). */
  async #readWorld(folder: string): Promise<World | null> {
    const path = join(this.dir(folder), 'world.md');
    if (!existsSync(path)) return null;
    const doc = parseDocument(await readFile(path, 'utf8'));
    let id = typeof doc.data.id === 'string' ? doc.data.id : null;
    const repo = this.repo(folder);
    await repo.ensure();
    if (!id && !doc.error) {
      id = newId();
      await repo.run(async () => {
        await writeFile(path, stringifyDocument({ data: { id, ...doc.data }, body: doc.body }));
        await repo.commitNow('Add world ID');
      });
    }
    if (!id) return null;
    return {
      id,
      folder,
      name: stringValue(doc.data.name, folder),
      summary: stringValue(doc.data.summary),
      theme: sanitizeTheme(doc.data.theme),
    };
  }
}
