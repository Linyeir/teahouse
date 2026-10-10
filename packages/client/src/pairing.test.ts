import { describe, expect, it } from 'vitest';
import { isLoopback, pairingLink, parsePairing } from './pairing.ts';

describe('pairing links', () => {
  it('round-trip server and code, including a sub-path', () => {
    const link = pairingLink('https://tea.example/teahouse/', 'ABCDE12345');
    expect(link).toBe('https://tea.example/teahouse/pair#code=ABCDE12345');
    expect(parsePairing(link)).toEqual({
      server: 'https://tea.example/teahouse',
      code: 'ABCDE12345',
      pin: null,
    });
    expect(parsePairing('http://192.168.1.5:8787/pair#code=X1')).toEqual({
      server: 'http://192.168.1.5:8787',
      code: 'X1',
      pin: null,
    });
  });

  it('accept a bare code and reject other links', () => {
    expect(parsePairing(' abcde-12345 ')).toEqual({
      server: null,
      code: 'abcde-12345',
      pin: null,
    });
    expect(parsePairing('https://tea.example/chats#code=1')).toBeNull();
    expect(parsePairing('https://tea.example/pair')).toBeNull();
    expect(parsePairing('hi')).toBeNull();
  });

  it('carry the fingerprint of a trusted certificate', () => {
    const pin = Array.from({ length: 32 }, (_, i) =>
      i.toString(16).padStart(2, '0').toUpperCase(),
    ).join(':');
    const link = pairingLink('https://tea.lan', 'ABCDE12345', pin);
    expect(link).toBe(`https://tea.lan/pair#code=ABCDE12345&pin=${pin.replace(/:/g, '')}`);
    expect(parsePairing(link)).toEqual({ server: 'https://tea.lan', code: 'ABCDE12345', pin });
    // Lower case, as a QR code reader might hand it over.
    expect(parsePairing(link.toLowerCase().replace('abcde12345', 'ABCDE12345'))?.pin).toBe(pin);
  });

  it('ignore a fingerprint that is not one', () => {
    for (const pin of ['abc', 'g'.repeat(64), 'ab'.repeat(31), 'ab'.repeat(33)]) {
      expect(parsePairing(`https://tea.lan/pair#code=X1&pin=${pin}`)?.pin).toBeNull();
    }
  });

  it('spot addresses other devices cannot reach', () => {
    expect(isLoopback('http://localhost:8787')).toBe(true);
    expect(isLoopback('http://127.0.0.1:5173')).toBe(true);
    expect(isLoopback('http://192.168.1.5:8787')).toBe(false);
  });
});
