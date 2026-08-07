import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import type { Request, Response, CookieOptions } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

/** Cookie carrying the device trust token. HTTP-only — JS never touches it. */
export const TRUSTED_DEVICE_COOKIE = 'crm.device';

/**
 * Scoped to the auth routes only. The cookie is a bearer credential for skipping
 * the second factor, so it is sent on as few requests as possible — login, OTP
 * verify, and the trusted-device management endpoints all live under /api/auth.
 */
const COOKIE_PATH = '/api/auth';

/** Expired/revoked rows are kept this long for the admin audit view, then pruned. */
const PRUNE_AFTER_DAYS = 30;

/**
 * Separates the per-account tokens inside the one cookie. Not a character that
 * appears in a uuid, base64url or the dots that join a token's three parts.
 */
const TOKEN_SEPARATOR = '~';

/**
 * How many accounts one browser may stay trusted for at once. Shared machines are
 * real, but so is the 4KB cookie limit; at roughly 125 bytes a token this leaves
 * an enormous margin while still bounding the header. The least recently trusted
 * entry falls off the end.
 */
const MAX_TRUSTED_ACCOUNTS = 5;

/**
 * Lifetime given to the cookie when it is rewritten without a fresh OTP (dropping
 * one account's entry). Generous on purpose: the cookie is only a carrier, and
 * every entry inside it is checked against its own row and expiry on each login,
 * so an over-long cookie can't extend anyone's actual trust.
 */
const MAX_COOKIE_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export interface DeviceInfo {
  deviceName: string;
  browser: string;
  os: string;
  userAgent: string;
  ipAddress: string | null;
}

/**
 * Minimal User-Agent classification — enough to label a row in the admin list
 * ("Chrome on Windows"), not a device-fingerprinting library. The UA is stored
 * verbatim too, so nothing is lost when this can't place a browser.
 */
export function parseUserAgent(ua: string): { browser: string; os: string; deviceName: string } {
  const s = ua || '';
  // Order matters: Edge/Opera/Brave all advertise Chrome, Chrome advertises Safari.
  const browser =
    /Edg[eA]?\//.test(s) ? 'Microsoft Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\/|CriOS/.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : 'Unknown browser';

  const os =
    /Windows NT 10|Windows NT 11/.test(s) ? 'Windows'
    : /Windows/.test(s) ? 'Windows'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
    : /Android/.test(s) ? 'Android'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /CrOS/.test(s) ? 'ChromeOS'
    : /Linux/.test(s) ? 'Linux'
    : 'Unknown OS';

  const deviceName =
    browser === 'Unknown browser' && os === 'Unknown OS' ? 'Unknown device' : `${browser} on ${os}`;
  return { browser, os, deviceName };
}

@Injectable()
export class TrustedDeviceService {
  private readonly logger = new Logger(TrustedDeviceService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Cookie plumbing ──────────────────────────────────────

  /**
   * Secret the cookie is signed with. Falls back to the access-token secret so a
   * deployment that hasn't set TRUSTED_DEVICE_SECRET still gets a real key rather
   * than a hard-coded one — but a rotation of either invalidates every device,
   * which is the safe direction to fail.
   */
  private get signingSecret(): string {
    return (
      process.env.TRUSTED_DEVICE_SECRET ??
      process.env.JWT_ACCESS_SECRET ??
      'change-me-access-secret'
    );
  }

  private cookieOptions(maxAgeMs?: number): CookieOptions {
    // Cross-site deployments (web and API on different registrable domains) need
    // SameSite=None, which browsers only accept alongside Secure. Same-site or
    // same-host setups keep Lax, which is strictly safer against CSRF.
    const sameSite = (process.env.TRUSTED_DEVICE_COOKIE_SAMESITE ?? 'lax').toLowerCase() as
      | 'lax'
      | 'strict'
      | 'none';
    const secure =
      sameSite === 'none' ||
      (process.env.TRUSTED_DEVICE_COOKIE_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';
    return {
      httpOnly: true,
      secure,
      sameSite,
      path: COOKIE_PATH,
      ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
      ...(process.env.TRUSTED_DEVICE_COOKIE_DOMAIN ? { domain: process.env.TRUSTED_DEVICE_COOKIE_DOMAIN } : {}),
    };
  }

  /**
   * Read the cookie header directly — cookie-parser isn't installed, and this is
   * the only cookie the API reads.
   */
  private readCookie(req: Request): string | null {
    const header = req.headers?.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === TRUSTED_DEVICE_COOKIE) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
    return null;
  }

  /** `<deviceId>.<verifier>.<hmac>` — tampering is rejected before any DB hit. */
  private sign(id: string, verifier: string): string {
    return crypto.createHmac('sha256', this.signingSecret).update(`${id}.${verifier}`).digest('base64url');
  }

  private hash(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('hex');
  }

  private parseToken(raw: string): { id: string; verifier: string } | null {
    const [id, verifier, sig] = raw.split('.');
    if (!id || !verifier || !sig) return null;
    const expected = this.sign(id, verifier);
    // Length check first: timingSafeEqual throws on a length mismatch.
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return { id, verifier };
  }

  /**
   * Every trust token the browser is carrying, tampered ones dropped.
   *
   * The cookie holds a LIST, one entry per account that has answered a code on
   * this browser. It used to hold exactly one, which meant two people sharing a
   * machine — or one person with an admin and an employee login, which is the
   * normal way this gets tested — knocked each other's trust out on every
   * switch: the second sign-in found a cookie belonging to the first, treated it
   * as a miss, cleared it, and sent a code. Then the first came back and the same
   * thing happened in reverse, so neither ever kept their trust and both were
   * asked for a code every single time.
   */
  private parseTokens(raw: string | null): { id: string; verifier: string }[] {
    if (!raw) return [];
    return raw
      .split(TOKEN_SEPARATOR)
      .map((t) => this.parseToken(t.trim()))
      .filter((t): t is { id: string; verifier: string } => !!t);
  }

  /** Re-assemble a cookie value from tokens, newest first and bounded. */
  private serialiseTokens(tokens: { id: string; verifier: string }[]): string {
    return tokens
      .slice(0, MAX_TRUSTED_ACCOUNTS)
      .map((t) => `${t.id}.${t.verifier}.${this.sign(t.id, t.verifier)}`)
      .join(TOKEN_SEPARATOR);
  }

  describe(req: Request): DeviceInfo {
    const userAgent = (req.headers?.['user-agent'] as string | undefined) ?? '';
    const { browser, os, deviceName } = parseUserAgent(userAgent);
    const forwarded = (req.headers?.['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    return { deviceName, browser, os, userAgent: userAgent.slice(0, 500), ipAddress: forwarded || req.ip || null };
  }

  // ── Trust checks ─────────────────────────────────────────

  /**
   * Is the caller's browser already trusted for this user? Returns the row (and
   * stamps it as used) only when the cookie verifies, the record belongs to this
   * user, and it is neither revoked nor past its expiry. Anything else is a miss
   * and the caller falls through to the OTP challenge.
   *
   * The expiry is NOT extended here: a device is trusted for a fixed window from
   * the OTP that created it, and re-verification is what buys another window.
   */
  async isTrusted(req: Request, userId: string): Promise<boolean> {
    // Check every token the browser carries, not just the first: the cookie holds
    // one per account, and this user's may not be at the front.
    const tokens = this.parseTokens(this.readCookie(req));
    if (!tokens.length) return false;

    // One query for the whole cookie. Walking the tokens one at a time meant a
    // database round trip per account on the browser — up to five, in series, on
    // the fast path that exists precisely to make signing in quick. The
    // ownership, revocation and expiry conditions move into the query, so a row
    // that comes back is already a candidate.
    const devices = await this.prisma.trustedDevice
      .findMany({
        where: { id: { in: tokens.map((t) => t.id) }, userId, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, tokenHash: true },
      })
      .catch(() => []);
    if (!devices.length) return false;

    const hashById = new Map(devices.map((d) => [d.id, d.tokenHash]));
    for (const parsed of tokens) {
      const tokenHash = hashById.get(parsed.id);
      if (!tokenHash) continue;

      const expected = Buffer.from(tokenHash);
      const actual = Buffer.from(this.hash(parsed.verifier));
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) continue;

      // "Last used" is a line in the admin device list, not something the person
      // signing in has any reason to wait for.
      void this.prisma.trustedDevice
        .update({ where: { id: parsed.id }, data: { lastLoginAt: new Date() } })
        .catch(() => undefined);
      return true;
    }
    return false;
  }

  /**
   * Mark the caller's browser trusted for `days` and hand it the cookie. Called
   * only after a successful OTP verification — the code is what buys the trust.
   */
  async remember(req: Request, res: Response, userId: string, days: number): Promise<Date> {
    const info = this.describe(req);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const maxAgeMs = days * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + maxAgeMs);

    // Re-verifying on a device that already had a (possibly expired) record
    // supersedes it, so the list shows one row per device rather than a pile.
    // Only THIS user's entries are superseded — tokens belonging to other
    // accounts on the same browser are carried over untouched.
    const carried = this.parseTokens(this.readCookie(req));
    const owned = carried.length
      ? await this.prisma.trustedDevice.findMany({
          where: { id: { in: carried.map((t) => t.id) }, userId },
          select: { id: true },
        })
      : [];
    const ownedIds = new Set(owned.map((d) => d.id));
    if (ownedIds.size) {
      await this.prisma.trustedDevice
        .deleteMany({ where: { id: { in: [...ownedIds] }, userId } })
        .catch(() => undefined);
    }

    const device = await this.prisma.trustedDevice.create({
      data: {
        userId,
        tokenHash: this.hash(verifier),
        deviceName: info.deviceName,
        browser: info.browser,
        os: info.os,
        userAgent: info.userAgent,
        ipAddress: info.ipAddress,
        expiresAt,
      },
      select: { id: true },
    });

    // This user's new token goes to the front; every other account's is kept, so
    // a shared browser stays trusted for all of them at once.
    const others = carried.filter((t) => !ownedIds.has(t.id));
    const value = this.serialiseTokens([{ id: device.id, verifier }, ...others]);
    res.cookie(TRUSTED_DEVICE_COOKIE, value, this.cookieOptions(maxAgeMs));
    // Table housekeeping, not part of signing in — it runs behind the response.
    void this.prune(userId);
    return expiresAt;
  }

  /**
   * Drop just THIS user's trust from the browser, leaving other accounts alone.
   *
   * Called when a cookie is present but this user's entry in it is dead — expired
   * or revoked. Clearing the whole cookie here is what made a shared browser
   * un-trustable: signing in as a second account wiped the first account's trust
   * as a side effect, so both were asked for a code on every switch.
   */
  async dropUser(req: Request, res: Response, userId: string) {
    const carried = this.parseTokens(this.readCookie(req));
    if (!carried.length) return;
    const mine = await this.prisma.trustedDevice
      .findMany({ where: { id: { in: carried.map((t) => t.id) }, userId }, select: { id: true } })
      .catch(() => []);
    const mineIds = new Set(mine.map((d) => d.id));
    const others = carried.filter((t) => !mineIds.has(t.id));
    if (others.length === carried.length) return; // nothing of this user's to drop
    if (others.length === 0) {
      res.clearCookie(TRUSTED_DEVICE_COOKIE, this.cookieOptions());
      return;
    }
    // Keep the remaining accounts trusted; the longest window still standing
    // governs how long the browser holds them.
    res.cookie(TRUSTED_DEVICE_COOKIE, this.serialiseTokens(others), this.cookieOptions(MAX_COOKIE_AGE_MS));
  }

  /** Id of the device the request is coming from, so the UI can say "this device". */
  currentDeviceId(req: Request): string | null {
    const raw = this.readCookie(req);
    return raw ? (this.parseToken(raw)?.id ?? null) : null;
  }

  // ── Management ───────────────────────────────────────────

  async list(userId: string, currentId: string | null) {
    const rows = await this.prisma.trustedDevice.findMany({
      where: { userId },
      // Live devices first (revokedAt is null for those), then most recently used.
      orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { lastLoginAt: 'desc' }],
    });
    return rows.map((d) => this.toView(d, currentId));
  }

  /** Every user's devices, for the admin Trusted Devices panel. */
  async listAll(currentId: string | null) {
    const rows = await this.prisma.trustedDevice.findMany({
      // Live devices first (revokedAt is null for those), then most recently used.
      orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { lastLoginAt: 'desc' }],
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return rows.map((d) => ({ ...this.toView(d, currentId), user: d.user }));
  }

  /**
   * Revoke one device. Non-admins may only revoke their own — a device id is a
   * plain uuid, so ownership has to be checked rather than assumed.
   */
  async revoke(id: string, actor: { id: string; role: string }) {
    const device = await this.prisma.trustedDevice.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('Trusted device not found');
    if (device.userId !== actor.id && actor.role !== 'admin') {
      throw new ForbiddenException('You can only revoke your own trusted devices');
    }
    if (!device.revokedAt) {
      await this.prisma.trustedDevice.update({ where: { id }, data: { revokedAt: new Date() } });
      await this.audit(device.userId, 'trusted_device_revoked', `Trusted device revoked: ${device.deviceName}`);
    }
    return { revoked: 1 };
  }

  /** Revoke every live device for a user (admin bulk action / self "sign out everywhere"). */
  async revokeAll(userId: string, reason = 'Trusted devices revoked') {
    const { count } = await this.prisma.trustedDevice.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count > 0) await this.audit(userId, 'trusted_device_revoked', `${reason} (${count} device(s))`);
    return { revoked: count };
  }

  /**
   * Any change to how an account authenticates drops all of its device trust, so
   * the next sign-in from every browser has to answer a fresh code.
   *
   * The triggers are the ones where leaving trust in place would defeat the
   * change itself:
   *  • password change — the point of a reset is that whoever held the old
   *    password is locked out, and a device that can skip OTP survives it;
   *  • MFA turned on or off — the factors guarding the account just changed, so
   *    devices vouched for under the old arrangement no longer stand;
   *  • an account being deactivated — an administrator pulling access must not
   *    leave a browser that walks straight back in if the account is restored.
   *
   * Never throws. A failure to revoke must not block the security change that
   * prompted it — the change is the more important half, and it is logged.
   */
  async revokeOnSecurityChange(userId: string, reason: string) {
    try {
      await this.revokeAll(userId, `Trusted devices revoked after ${reason}`);
    } catch (err) {
      this.logger.warn(`Could not revoke trusted devices for ${userId} after ${reason}: ${String(err)}`);
    }
  }

  // ── Internals ────────────────────────────────────────────

  private toView(
    d: { id: string; deviceName: string; browser: string; os: string; ipAddress: string | null; lastLoginAt: Date; expiresAt: Date; revokedAt: Date | null; createdAt: Date },
    currentId: string | null,
  ) {
    const active = !d.revokedAt && d.expiresAt > new Date();
    return {
      id: d.id,
      deviceName: d.deviceName,
      browser: d.browser,
      os: d.os,
      ipAddress: d.ipAddress,
      lastLoginAt: d.lastLoginAt,
      trustedUntil: d.expiresAt,
      createdAt: d.createdAt,
      revokedAt: d.revokedAt,
      status: d.revokedAt ? ('revoked' as const) : active ? ('active' as const) : ('expired' as const),
      current: currentId === d.id,
    };
  }

  /** Keep the table from growing forever without hiding recent revocations. */
  private async prune(userId: string) {
    const cutoff = new Date(Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.trustedDevice
      .deleteMany({
        where: { userId, OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
      })
      .catch(() => undefined);
  }

  private async audit(userId: string, action: string, remarks: string) {
    try {
      await this.prisma.activity.create({ data: { leadId: null, userId, action, oldValue: null, newValue: null, remarks } });
    } catch {
      /* auditing must never block the action */
    }
  }
}
