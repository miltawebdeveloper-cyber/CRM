import { describe, expect, it } from '@jest/globals';
import { isPublicAddress, safeFetch, UnsafeUrlError } from './safe-fetch.js';

/**
 * The recording proxy fetches URLs that arrived in webhooks. These pin the
 * refusals that keep such a URL from reaching anything inside the network.
 * None of them touches the internet: each is refused before a request is sent,
 * or at the local DNS lookup of `localhost`.
 */
describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.10',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '[::1]',
  ])('refuses %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'accepts %s',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );

  it('refuses things that are not addresses at all', () => {
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });
});

describe('safeFetch refusals', () => {
  it.each([
    ['plain HTTP', 'http://example.com/a.mp3'],
    ['a loopback literal', 'https://127.0.0.1/a.mp3'],
    ['the metadata endpoint', 'https://169.254.169.254/latest/meta-data/'],
    ['an IPv6 loopback literal', 'https://[::1]/a.mp3'],
    ['a file URL', 'file:///etc/passwd'],
  ])('refuses %s before sending anything', async (_label, url) => {
    await expect(safeFetch(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a hostname that resolves to a private address', async () => {
    await expect(safeFetch('https://localhost/a.mp3', { timeoutMs: 5_000 })).rejects.toThrow(/non-public/);
  });

  it('enforces the host allowlist when one is configured', async () => {
    await expect(safeFetch('https://evil.example/a.mp3', { allowedHosts: ['quo.com'] })).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
