/**
 * Pairing links carry the server address and a one-time code: `<server>/pair#code=<code>`.
 * The code sits in the fragment, so it never reaches server or proxy logs when a phone
 * opens the link in its browser. The apps read the same link from the QR code.
 */
export function pairingLink(server: string, code: string): string {
  return `${server.replace(/\/+$/, '')}/pair#code=${encodeURIComponent(code)}`;
}

export interface ParsedPairing {
  /** Server base URL, or null when only a code was given. */
  server: string | null;
  code: string;
}

/** Reads a pairing link, or a bare code typed by hand. */
export function parsePairing(input: string): ParsedPairing | null {
  const text = input.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return /^[0-9a-z\s-]{6,40}$/i.test(text) ? { server: null, code: text } : null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const code = new URLSearchParams(url.hash.slice(1)).get('code');
  if (!code || !url.pathname.endsWith('/pair')) return null;
  return { server: `${url.origin}${url.pathname.slice(0, -'/pair'.length)}`, code };
}

/** Hosts other devices cannot reach, so the QR code needs another address. */
export function isLoopback(server: string): boolean {
  try {
    const host = new URL(server).hostname;
    return host === 'localhost' || host === '[::1]' || host.startsWith('127.');
  } catch {
    return false;
  }
}
