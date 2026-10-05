import { join } from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';

const config = loadConfig();
const db = openDb(join(config.dataDir, 'teahouse.db'));
const app = await buildApp({ db, clientDir: config.clientDir, logger: { level: 'info' } });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
