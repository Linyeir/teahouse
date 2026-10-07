import { randomInt } from 'node:crypto';

/** Crockford base32 without the easily confused I, L, O and U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 10;
export const PAIRING_TTL_MS = 5 * 60_000;

interface PendingCode {
  expiresAt: number;
  createdBy: string;
}

/** Normalizes typed codes: case, dashes and spaces do not matter, and O/I/L read as 0/1. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/**
 * One-time codes that let a new device sign in without the password (concept, section 3).
 * Codes live in memory only: a server restart invalidates them, which is fine for a
 * five-minute window. 50 bits of entropy plus the login rate limit make guessing hopeless.
 */
export class Pairing {
  readonly #codes = new Map<string, PendingCode>();

  constructor(private readonly clock: () => number = Date.now) {}

  create(createdBy: string): { code: string; expiresAt: string } {
    this.#prune();
    let code = '';
    for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    const expiresAt = this.clock() + PAIRING_TTL_MS;
    this.#codes.set(code, { expiresAt, createdBy });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Consumes a code. Returns false for unknown, used or expired codes. */
  claim(input: string): boolean {
    this.#prune();
    const code = normalizeCode(input);
    if (!this.#codes.has(code)) return false;
    this.#codes.delete(code);
    return true;
  }

  /** Codes created by a device die with its token. */
  revokeFrom(deviceId: string): void {
    for (const [code, pending] of this.#codes) {
      if (pending.createdBy === deviceId) this.#codes.delete(code);
    }
  }

  #prune(): void {
    const now = this.clock();
    for (const [code, pending] of this.#codes) {
      if (pending.expiresAt <= now) this.#codes.delete(code);
    }
  }
}
