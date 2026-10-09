import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };

/** The Teahouse version. `pnpm version:set` writes it into every package (see README). */
export const TEAHOUSE_VERSION: string = pkg.version;

/**
 * Compatibility number of the API, the WebSocket events and the sync format. It changes only
 * when a change breaks older apps or servers, not with every release, so an app and a server
 * of different versions keep working together as long as it matches.
 *
 * 1: everything up to 0.3.2. Servers before 0.3.2 have no `/api/version` and count as 1.
 */
export const API_VERSION = 1;

/** `GET /api/version`, public so the connect screen can check a server before signing in. */
export const serverVersion = z.object({ version: z.string(), api: z.number().int() });
export type ServerVersion = z.infer<typeof serverVersion>;

export type Compatibility = 'ok' | 'update-server' | 'update-app';

/** Which side has to be updated for this app to work with a server of API version `api`. */
export function compatibility(api: number, own = API_VERSION): Compatibility {
  if (api === own) return 'ok';
  return api < own ? 'update-server' : 'update-app';
}
