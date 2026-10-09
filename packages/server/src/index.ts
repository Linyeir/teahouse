import { join } from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { WorldService } from './worlds/service.ts';
import { WorldWatcher } from './worlds/watcher.ts';

const config = loadConfig();
let backup: string | null = null;
const db = openDb(join(config.dataDir, 'teahouse.db'), { onBackup: (path) => (backup = path) });
const worlds = new WorldService(config.worldsDir);
await worlds.init();
const watcher = new WorldWatcher(worlds);
await watcher.start();

const app = await buildApp({
  db,
  worlds,
  clientDir: config.clientDir,
  corsOrigins: config.corsOrigins,
  logger: { level: 'info' },
});
app.addHook('onClose', () => watcher.stop());
if (backup) app.log.info({ backup }, 'Backed up the database before migrating it');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
