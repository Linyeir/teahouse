import { isAndroidApp } from './platform.ts';

/** The Android app can read the pairing QR code with the camera. */
export const canScan = isAndroidApp;

export class ScanError extends Error {}

/** Opens the camera and returns the text of the first QR code, or null when cancelled. */
export async function scanQrCode(): Promise<string | null> {
  // Loaded on demand: the plugin only exists inside the Android app.
  const scanner = await import('@tauri-apps/plugin-barcode-scanner');
  let permission = await scanner.checkPermissions();
  if (permission !== 'granted') permission = await scanner.requestPermissions();
  if (permission !== 'granted') throw new ScanError('camera');
  try {
    const result = await scanner.scan({ windowed: false, formats: [scanner.Format.QRCode] });
    return result.content || null;
  } catch (err) {
    // Backing out of the camera view rejects; that is not an error for the user.
    if (String(err).toLowerCase().includes('cancel')) return null;
    throw err;
  }
}
