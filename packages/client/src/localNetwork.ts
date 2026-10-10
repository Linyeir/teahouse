import { checkPermissions, invoke, requestPermissions } from '@tauri-apps/api/core';
import { isAndroidApp } from './platform.ts';

type PermissionState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';

/**
 * Whether the app may use the local network. Android 17 blocks it for the app, webview
 * included, until the user allows it ("Nearby devices"). The plugin in
 * packages/app/src-tauri/plugins/local-network says granted on older versions, which have no
 * such permission.
 */
export async function localNetworkAllowed(): Promise<boolean> {
  if (!isAndroidApp) return true;
  const { localNetwork } = await checkPermissions<{ localNetwork: PermissionState }>(
    'local-network',
  );
  return localNetwork === 'granted';
}

/** Shows Android's permission dialog, unless the user has turned it down for good. */
export async function requestLocalNetwork(): Promise<boolean> {
  const { localNetwork } = await requestPermissions<{ localNetwork: PermissionState }>(
    'local-network',
  );
  return localNetwork === 'granted';
}

/** The app's page in the system settings, where "Nearby devices" can still be allowed. */
export function openAppSettings(): Promise<void> {
  return invoke('plugin:local-network|open_app_settings');
}

/**
 * Whether `server` is on the local network by its address alone. A domain that resolves to a
 * LAN address is not recognised; the diagnosis offers the permission for those.
 */
export function looksLocal(server: string): boolean {
  let host: string;
  try {
    host = new URL(server).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[')) {
    // fc00::/7 (unique local) and fe80::/10 (link-local)
    return /^\[(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host);
  }
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return !host.includes('.') || /\.(local|lan|home|internal|home\.arpa)$/.test(host);
}

// The one dialog per start; later requests wait for its answer instead of asking again.
let asked: Promise<boolean> | null = null;

/**
 * Whether a request to `server` may go out. Asks once per start for a server on the local
 * network. Android drops blocked connections silently, so without the permission a request
 * would hang for about two minutes before it fails; the caller fails it at once instead.
 */
export async function ensureLocalNetwork(server: string): Promise<boolean> {
  if (!isAndroidApp || !looksLocal(server)) return true;
  try {
    if (await localNetworkAllowed()) return true;
    asked ??= requestLocalNetwork();
    return (await asked) || (await localNetworkAllowed());
  } catch (err) {
    // Unknown: let the request try.
    console.warn('Local network permission:', err);
    return true;
  }
}
