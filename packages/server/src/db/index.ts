import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const defaultMigrations = fileURLToPath(new URL('./migrations', import.meta.url));

/** Backups kept in `<data>/backups/`; older ones are deleted when a new one is made. */
export const KEEP_BACKUPS = 5;

export interface OpenDbOptions {
  /** Other migrations than the bundled ones, for tests. */
  migrationsFolder?: string;
  /** Called with the backup's path before pending migrations run. */
  onBackup?: (path: string) => void;
}

export function openDb(file: string, options: OpenDbOptions = {}): Db {
  const { migrationsFolder = defaultMigrations, onBackup } = options;
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });

  // A pulled image migrates on startup. The copy lets an update be undone by going back to
  // the previous image with the database as it was.
  const backup =
    file !== ':memory:' && hasPendingMigrations(sqlite, migrationsFolder)
      ? backupDb(sqlite, join(dirname(file), 'backups'))
      : null;
  if (backup) onBackup?.(backup);
  try {
    migrate(db, { migrationsFolder });
  } catch (err) {
    if (!backup) throw err;
    throw new Error(`Migrating the database failed. Its state before is in ${backup}`, {
      cause: err,
    });
  }
  return db;
}

/**
 * Whether drizzle's `migrate` would apply anything to an existing database: the same test it
 * makes, a migration newer than the last one recorded. A new database has nothing to lose.
 */
function hasPendingMigrations(sqlite: Database.Database, migrationsFolder: string): boolean {
  const table = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (!table) return false;
  const last = sqlite
    .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
    .pluck()
    .get();
  const applied = last === undefined ? -1 : Number(last);
  return readMigrationFiles({ migrationsFolder }).some((m) => m.folderMillis > applied);
}

/**
 * Writes a consistent copy of the database to `dir` and deletes all but the newest
 * `KEEP_BACKUPS`. `VACUUM INTO` includes what is still in the WAL file, which copying the
 * database file would miss.
 */
export function backupDb(sqlite: Database.Database, dir: string, now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  // 2026-10-09T21:30:00.123Z → 2026-10-09T21-30-00Z: sortable and valid on every filesystem.
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '-');
  const path = join(dir, `teahouse-${stamp}.db`);
  sqlite.prepare('VACUUM INTO ?').run(path);
  const old = readdirSync(dir)
    .filter((name) => /^teahouse-.+\.db$/.test(name))
    .sort()
    .slice(0, -KEEP_BACKUPS);
  for (const name of old) rmSync(join(dir, name));
  return path;
}

export { schema };
