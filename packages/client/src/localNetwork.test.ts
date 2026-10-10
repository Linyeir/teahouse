import { describe, expect, it } from 'vitest';
import { looksLocal } from './localNetwork.ts';

describe('looksLocal', () => {
  it('recognises private and link-local addresses', () => {
    for (const server of [
      'http://192.168.1.10:8787',
      'http://10.0.0.5',
      'https://172.16.0.1',
      'https://172.31.255.255',
      'http://169.254.10.10',
      'http://[fd12:3456::1]:8787',
      'http://[fe80::1]',
    ]) {
      expect(looksLocal(server), server).toBe(true);
    }
  });

  it('recognises local names', () => {
    for (const server of [
      'http://teahouse:8787',
      'https://nas.local',
      'https://teahouse.lan',
      'https://teahouse.home.arpa',
      'https://box.internal',
    ]) {
      expect(looksLocal(server), server).toBe(true);
    }
  });

  it('leaves public and VPN addresses alone', () => {
    for (const server of [
      'https://teahouse.example.com',
      'https://box.tail1234.ts.net',
      'http://100.101.102.103:8787',
      'https://172.32.0.1',
      'https://8.8.8.8',
      'http://[2001:db8::1]',
      'not a url',
    ]) {
      expect(looksLocal(server), server).toBe(false);
    }
  });
});
