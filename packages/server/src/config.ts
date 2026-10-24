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

/** Whether a bind address only accepts connections from this machine. */
export function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * The startup warning for a server other machines can reach: Teahouse speaks plain HTTP, so
 * without a TLS proxy in front the password and device tokens cross the network readable.
 * Null on loopback, where only a proxy on the same machine (or nothing) can connect.
 */
export function plainHttpWarning(host: string): string | null {
  if (isLoopback(host)) return null;
  return (
    'Teahouse serves plain HTTP on an address other machines can reach: the password and ' +
    'device tokens cross the network unencrypted. Fine inside your own LAN or a VPN; ' +
    'anything else needs HTTPS through a reverse proxy or Tailscale: https://github.com/Linyeir/teahouse/blob/main/docs/https.md'
  );
}
