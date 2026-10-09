import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import { backupDb, KEEP_BACKUPS, openDb } from '../src/db/index.ts';

const bundled = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The bundled migrations up to `count`, plus optional extra ones, as an older or newer release. */
async function migrations(count: number, extra: { tag: string; sql: string }[] = []) {
  const dir = await tempDir('teahouse-migrations-');
  await cp(bundled, dir, { recursive: true });
  const journalFile = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  journal.entries = journal.entries.slice(0, count);
  for (const [i, { tag, sql }] of extra.entries()) {
    await writeFile(join(dir, `${tag}.sql`), sql);
    const when = journal.entries.at(-1).when + 1000 * (i + 1);
    journal.entries.push({
      idx: journal.entries.length,
      version: '6',
      when,
      tag,
      breakpoints: true,
    });
  }
  await writeFile(journalFile, JSON.stringify(journal));
  return dir;
}

const tables = (file: string) => {
  const sqlite = new Database(file, { readonly: true });
  try {
    return sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[];
  } finally {
    sqlite.close();
  }
};

describe('database backups', () => {
  it('copies the database before pending migrations run, and only then', async () => {
    const data = await tempDir('teahouse-data-');
    const file = join(data, 'teahouse.db');
    const backups: string[] = [];
    const onBackup = (path: string) => backups.push(path);

    // A new database has nothing to back up.
    openDb(file, { migrationsFolder: await migrations(2), onBackup }).$client.close();
    expect(backups).toEqual([]);
    const before = tables(file);
    expect(before).not.toContain('scenes');

    // An update with a new migration backs up the database as it was.
    openDb(file, { onBackup }).$client.close();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/backups[/\\]teahouse-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.db$/);
    expect(tables(backups[0] as string).sort()).toEqual(before.sort());
    expect(tables(file)).toContain('scenes');

    // Nothing pending: no backup.
    openDb(file, { onBackup }).$client.close();
    expect(backups).toHaveLength(1);
  });

  it('names the backup when a migration fails', async () => {
    const data = await tempDir('teahouse-data-');
    const file = join(data, 'teahouse.db');
    openDb(file).$client.close();
    const broken = await migrations(3, [{ tag: '0003_broken', sql: 'NOT SQL AT ALL;' }]);
    expect(() => openDb(file, { migrationsFolder: broken })).toThrow(
      /Migrating the database failed\. Its state before is in .*teahouse-.*\.db/,
    );
  });

  it(`keeps the newest ${KEEP_BACKUPS} backups`, async () => {
    const dir = await tempDir('teahouse-backups-');
    const sqlite = new Database(':memory:');
    onTestFinished(() => {
      sqlite.close();
    });
    sqlite.exec('CREATE TABLE t (x)');
    for (let day = 1; day <= KEEP_BACKUPS + 2; day++) {
      backupDb(sqlite, dir, new Date(Date.UTC(2026, 9, day, 12)));
    }
    const kept = (await readdir(dir)).sort();
    expect(kept).toHaveLength(KEEP_BACKUPS);
    expect(kept[0]).toBe('teahouse-2026-10-03T12-00-00Z.db');
    expect(kept.at(-1)).toBe(`teahouse-2026-10-0${KEEP_BACKUPS + 2}T12-00-00Z.db`);
  });
});
