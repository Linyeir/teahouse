import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  worldsDir: string;
  /** Built web client to serve, or null when it is not built (development). */
  clientDir: string | null;
  /** Extra browser origins allowed to call the API (`TEAHOUSE_CORS_ORIGINS`, comma-separated). */
  corsOrigins: string[];
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
    worldsDir: resolve(env.TEAHOUSE_WORLDS_DIR ?? `${dataDir}/worlds`),
    clientDir: existsSync(clientDir) ? clientDir : null,
    corsOrigins: (env.TEAHOUSE_CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
