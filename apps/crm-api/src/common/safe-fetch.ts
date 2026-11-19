import * as dns from 'node:dns';
import * as https from 'node:https';
import * as net from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Fetching a URL that came from outside — a recording link in a webhook or a
 * provider sync — without letting it point the server at itself.
 *
 * The recording proxy used to hand any stored URL straight to `fetch()` and
 * stream the answer back to the browser. Anyone able to get a URL into
 * `call_recordings` (a forged webhook, a compromised provider account) could
 * therefore read internal services or the cloud metadata endpoint through the
 * CRM. This helper closes that:
 *
 *  • HTTPS only, on every hop.
 *  • The address check runs INSIDE the socket's DNS lookup, so the IP that is
 *    checked is the IP that is connected to — a hostname that resolves to a
 *    public address for the check and a private one for the connection (DNS
 *    rebinding) gets nowhere. IP literals, which skip DNS, are checked directly.
 *  • Redirects are followed by hand (bounded), each hop re-checked.
 *  • A hard deadline and a byte cap, so one hung or enormous response cannot
 *    tie up the process or its memory.
 */

export interface SafeFetchOptions {
  /** Extra headers, sent only to hosts `sendHeadersTo` accepts. */
  headers?: Record<string, string>;
  /** Which hosts may receive `headers` (credentials). Default: none. */
  sendHeadersTo?: (host: string) => boolean;
  /** Hostnames the FIRST hop must match (suffix match). Unset = any public host. */
  allowedHosts?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchResponse {
  ok: boolean;
  status: number;
  contentType: string | null;
  /** Present only for 2xx responses. */
  body: Buffer | null;
}

export class UnsafeUrlError extends Error {}

/** True when an address is routable on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(addr)) {
    const [a, b, c] = addr.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast, reserved, broadcast
    return true;
  }
  if (net.isIPv6(addr)) {
    if (addr === '::' || addr === '::1') return false;
    // IPv4-mapped / -translated: judge the embedded IPv4 address.
    const mapped = addr.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(addr)) {
      // ::ffff:7f00:1 — the same mapping written in hex.
      const [hi, lo] = addr.slice(7).split(':').map((h) => parseInt(h, 16));
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(addr.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (addr.startsWith('2001:db8:') || addr === '2001:db8::') return false; // documentation
    return true;
  }
  return false;
}

/** `dns.lookup` replacement that refuses to hand a socket a non-public address. */
function publicOnlyLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as dns.LookupAddress[];
    const blocked = list.find((a) => !isPublicAddress(a.address));
    if (!list.length || blocked) {
      const e = new UnsafeUrlError(`Refusing to connect: ${hostname} resolves to a non-public address`) as NodeJS.ErrnoException;
      e.code = 'EUNSAFEADDRESS';
      return callback(e, '');
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function hostMatches(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const d = a.trim().toLowerCase().replace(/^\*?\./, '');
    return !!d && (h === d || h.endsWith(`.${d}`));
  });
}

function assertSafeUrl(url: URL, allowedHosts?: string[]): void {
  if (url.protocol !== 'https:') throw new UnsafeUrlError(`Refusing to fetch a non-HTTPS URL (${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // IP literals never reach the lookup hook, so they are judged here.
  if (net.isIP(host) && !isPublicAddress(host)) throw new UnsafeUrlError('Refusing to fetch a non-public address');
  if (allowedHosts?.length && !hostMatches(host, allowedHosts)) {
    throw new UnsafeUrlError(`Host ${host} is not in the allowed list`);
  }
}

type Hop =
  | { kind: 'redirect'; location: string; status: number }
  | { kind: 'response'; response: SafeFetchResponse };

function requestOnce(url: URL, headers: Record<string, string>, deadline: number, maxBytes: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Error('Timed out'));
    const req = https.request(url, { method: 'GET', headers, lookup: publicOnlyLookup, timeout: remaining }, (res) => {
      const status = res.statusCode ?? 0;
      const hdrs: IncomingHttpHeaders = res.headers;
      const contentType = (hdrs['content-type'] as string | undefined) ?? null;

      if (status >= 300 && status < 400 && hdrs.location) {
        res.resume();
        return resolve({ kind: 'redirect', location: hdrs.location, status });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return resolve({ kind: 'response', response: { ok: false, status, contentType, body: null } });
      }
      const declared = Number(hdrs['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        req.destroy();
        return reject(new Error(`Response too large (${declared} bytes, limit ${maxBytes})`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`Response too large (over ${maxBytes} bytes)`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ kind: 'response', response: { ok: true, status, contentType, body: Buffer.concat(chunks) } }));
      res.on('error', reject);
    });
    // `timeout` covers socket inactivity; the overall deadline covers a server
    // that trickles bytes forever.
    const timer = setTimeout(() => req.destroy(new Error('Timed out')), remaining);
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/**
 * GET an untrusted URL safely. Resolves with `ok: false` for an HTTP error
 * status (so callers can react to 403/404), and rejects for anything unsafe,
 * too large, too slow, or unreachable.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const deadline = Date.now() + timeoutMs;

  let url = new URL(rawUrl);
  assertSafeUrl(url, opts.allowedHosts);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (hop > 0) assertSafeUrl(url); // redirect targets: HTTPS + public, any host
    // Credentials go only where the caller said — never along a redirect to a
    // host it didn't name (the classic cross-origin credential leak).
    const headers = opts.headers && opts.sendHeadersTo?.(url.hostname) ? opts.headers : {};
    const result = await requestOnce(url, headers, deadline, maxBytes);
    if (result.kind === 'response') return result.response;
    url = new URL(result.location, url);
  }
  throw new UnsafeUrlError(`Too many redirects (more than ${maxRedirects})`);
}
