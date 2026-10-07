import { describe, expect, it } from 'vitest';
import { isLoopback, pairingLink, parsePairing } from './pairing.ts';

describe('pairing links', () => {
  it('round-trip server and code, including a sub-path', () => {
    const link = pairingLink('https://tea.example/teahouse/', 'ABCDE12345');
    expect(link).toBe('https://tea.example/teahouse/pair#code=ABCDE12345');
    expect(parsePairing(link)).toEqual({
      server: 'https://tea.example/teahouse',
      code: 'ABCDE12345',
    });
    expect(parsePairing('http://192.168.1.5:8787/pair#code=X1')).toEqual({
      server: 'http://192.168.1.5:8787',
      code: 'X1',
    });
  });

  it('accept a bare code and reject other links', () => {
    expect(parsePairing(' abcde-12345 ')).toEqual({ server: null, code: 'abcde-12345' });
    expect(parsePairing('https://tea.example/chats#code=1')).toBeNull();
    expect(parsePairing('https://tea.example/pair')).toBeNull();
    expect(parsePairing('hi')).toBeNull();
  });

  it('spot addresses other devices cannot reach', () => {
    expect(isLoopback('http://localhost:8787')).toBe(true);
    expect(isLoopback('http://127.0.0.1:5173')).toBe(true);
    expect(isLoopback('http://192.168.1.5:8787')).toBe(false);
  });
});
