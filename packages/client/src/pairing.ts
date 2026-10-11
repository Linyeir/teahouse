/**
 * Pairing links carry the server address and a one-time code: `<server>/pair#code=<code>`.
 * The code sits in the fragment, so it never reaches server or proxy logs when a phone
 * opens the link in its browser. The apps read the same link from the QR code.
 *
 * An app that trusts the server's certificate by its fingerprint (transport.ts) adds it as
 * `&pin=<64 hex digits>`, so the device it pairs trusts the same certificate without asking.
 */
export function pairingLink(server: string, code: string, pin: string | null = null): string {
  const fragment = `code=${encodeURIComponent(code)}`;
  const compact = pin?.replace(/:/g, '');
  return `${server.replace(/\/+$/, '')}/pair#${fragment}${compact ? `&pin=${compact}` : ''}`;
}

export interface ParsedPairing {
  /** Server base URL, or null when only a code was given. */
  server: string | null;
  code: string;
  /** The certificate fingerprint the pairing device trusts (`AB:CD:…`), if it sent one. */
  pin: string | null;
}

/** `ab12…` (64 hex digits) as `AB:12:…`; null for anything else. */
function parsePin(value: string | null): string | null {
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return value.toUpperCase().match(/../g)?.join(':') ?? null;
}

/** Reads a pairing link, or a bare code typed by hand. */
export function parsePairing(input: string): ParsedPairing | null {
  const text = input.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return /^[0-9a-z\s-]{6,40}$/i.test(text) ? { server: null, code: text, pin: null } : null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  const code = fragment.get('code');
  if (!code || !url.pathname.endsWith('/pair')) return null;
  return {
    server: `${url.origin}${url.pathname.slice(0, -'/pair'.length)}`,
    code,
    pin: parsePin(fragment.get('pin')),
  };
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
