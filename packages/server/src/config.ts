import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Built web client to serve, or null when it is not built (development). */
  clientDir: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.TEAHOUSE_DATA_DIR ?? 'data');
  mkdirSync(dataDir, { recursive: true });
  const clientDir = resolve(
    env.TEAHOUSE_CLIENT_DIR ?? fileURLToPath(new URL('../../client/dist', import.meta.url)),
  );
  return {
    host: env.TEAHOUSE_HOST ?? '0.0.0.0',
    port: Number(env.TEAHOUSE_PORT ?? 8787),
    dataDir,
    clientDir: existsSync(clientDir) ? clientDir : null,
  };
}
