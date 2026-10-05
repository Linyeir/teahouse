import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type SimpleGit, simpleGit } from 'simple-git';

// Passed as `-c` options, so commits work without a global Git identity on the host.
const IDENTITY = ['user.name=Teahouse', 'user.email=teahouse@localhost'];

export interface CommitInfo {
  sha: string;
  date: string;
  message: string;
}

/**
 * Git access to one world. All operations run one after another, so API writes, the file
 * watcher and canon commits never collide on the index lock.
 */
export class WorldRepo {
  readonly git: SimpleGit;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {
    // Only what Git needs: simple-git refuses inherited variables such as GIT_EDITOR, and
    // world repos are local, so no credential or proxy settings are required.
    const env: Record<string, string> = { LANG: 'C' };
    for (const key of ['PATH', 'HOME', 'SYSTEMROOT'] as const) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    this.git = simpleGit({ baseDir: dir, config: IDENTITY }).env(env);
  }

  /** Runs `task` after all queued operations of this world. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Creates the repository if the folder has none yet (e.g. a world copied in by hand). */
  ensure(): Promise<void> {
    return this.run(async () => {
      if (existsSync(join(this.dir, '.git'))) return;
      await this.git.init(['--initial-branch=main']);
    });
  }

  /** Stages everything and commits. Returns the new commit, or null when nothing changed. */
  commitAll(message: string): Promise<string | null> {
    return this.run(() => this.commitNow(message));
  }

  /** Commit inside an operation that already holds the queue. */
  async commitNow(message: string): Promise<string | null> {
    await this.git.add(['-A']);
    const status = await this.git.status();
    if (status.isClean()) return null;
    const result = await this.git.commit(message);
    return result.commit || null;
  }

  log(path?: string, maxCount = 100): Promise<CommitInfo[]> {
    return this.run(async () => {
      try {
        const log = await this.git.log({ maxCount, ...(path && { file: path }) });
        return log.all.map((c) => ({ sha: c.hash, date: c.date, message: c.message }));
      } catch {
        return []; // No commits yet.
      }
    });
  }

  show(sha: string, path: string): Promise<string> {
    return this.run(() => this.git.show([`${sha}:${path}`]));
  }
}
