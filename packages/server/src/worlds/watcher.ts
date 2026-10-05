import { relative, sep } from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import type { WorldService } from './service.ts';

/** Temporary files of common editors (vim, Emacs, JetBrains, Obsidian, LibreOffice …). */
const TEMP_FILE = /(^\.#|~$|\.swp$|\.swx$|\.tmp$|^4913$|___jb_\w+___$|^\.~lock)/;

/**
 * Commits changes made directly in the world folders (Obsidian, an editor, a script).
 * Changes are debounced per world, so a burst of saves becomes one commit.
 */
export class WorldWatcher {
  #watcher: FSWatcher | null = null;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(
    private readonly worlds: WorldService,
    private readonly debounceMs = 2000,
  ) {}

  start(): Promise<void> {
    const watcher = watch(this.worlds.root, {
      ignoreInitial: true,
      ignored: (path) => {
        const rel = relative(this.worlds.root, path);
        const parts = rel.split(sep);
        const name = parts.at(-1) ?? '';
        return parts.includes('.git') || parts.includes('.obsidian') || TEMP_FILE.test(name);
      },
    });
    watcher.on('all', (_event, path) => {
      const folder = relative(this.worlds.root, path).split(sep)[0];
      if (folder && !folder.startsWith('..')) this.#schedule(folder);
    });
    this.#watcher = watcher;
    return new Promise((resolve) => watcher.once('ready', () => resolve()));
  }

  async stop(): Promise<void> {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await this.#watcher?.close();
    await Promise.allSettled(this.#pending);
  }

  #schedule(folder: string): void {
    clearTimeout(this.#timers.get(folder));
    this.#timers.set(
      folder,
      setTimeout(() => {
        this.#timers.delete(folder);
        const commit = this.worlds
          .repo(folder)
          .commitAll('Edit outside Teahouse')
          .catch(() => undefined) // Not a world (yet), or Git failed; the next edit retries.
          .finally(() => this.#pending.delete(commit));
        this.#pending.add(commit);
      }, this.debounceMs),
    );
  }
}
