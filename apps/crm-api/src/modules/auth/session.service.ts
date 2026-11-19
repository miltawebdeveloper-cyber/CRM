import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * How long the refresh token from just before a rotation keeps working.
 *
 * Every open tab polls, so an expired access token sends several tabs to
 * refresh at once, all holding the same refresh token; a response can also be
 * lost after the server has already rotated. Inside this window the old token
 * is answered with the CURRENT generation instead of being treated as theft, so
 * the racing tabs converge on the same token. Outside it, an old token means
 * two parties hold the session and it is ended.
 */
const ROTATION_GRACE_MS = 30_000;

/** Ended and revoked sessions are kept this long (admin/audit), then pruned. */
const PRUNE_AFTER_DAYS = 30;

/**
 * Absolute session lifetime. Refreshing keeps a session alive day to day, but
 * no longer forever: after this many days the user signs in again (a trusted
 * device still skips the OTP). Configurable with SESSION_MAX_DAYS.
 */
export function sessionMaxDays(): number {
  const n = Number(process.env.SESSION_MAX_DAYS ?? 30);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), 365) : 30;
}

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
}

const ENDED = 'Your session has ended. Please sign in again.';

/**
 * Server-side sessions behind the JWTs. See the `AuthSession` model for why they
 * exist; in short, a token is only as good as the session row it names, so
 * logout, a password reset, deactivation and detected token theft all take
 * effect on the very next request rather than whenever the token expires.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Open a session for a user who has just completed every login step. */
  async create(userId: string, req?: Request): Promise<{ sid: string; generation: number }> {
    const userAgent = (req?.headers?.['user-agent'] as string | undefined)?.slice(0, 500) ?? null;
    const forwarded = (req?.headers?.['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    const session = await this.prisma.authSession.create({
      data: {
        userId,
        userAgent,
        ipAddress: forwarded || req?.ip || null,
        expiresAt: new Date(Date.now() + sessionMaxDays() * 86_400_000),
      },
      select: { id: true, generation: true },
    });
    // Housekeeping, not part of signing in.
    void this.prune(userId);
    return { sid: session.id, generation: session.generation };
  }

  /**
   * The per-request check behind every access token. One query — the session
   * and its user together — which replaces the user lookup the guard already
   * did, so revocability costs no extra round trip.
   */
  async validate(sid: string, userId: string): Promise<SessionUser | null> {
    const now = Date.now();
    const hit = this.validCache.get(sid);
    if (hit && hit.until > now && hit.expiresAt > now) {
      return hit.user.id === userId ? hit.user : null;
    }

    const s = await this.prisma.authSession.findUnique({
      where: { id: sid },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { id: true, email: true, role: true, isActive: true } },
      },
    });
    if (!s || s.userId !== userId || s.revokedAt || s.expiresAt <= new Date() || !s.user.isActive) {
      this.validCache.delete(sid);
      return null;
    }
    this.remember(sid, s.user, s.expiresAt.getTime());
    return s.user;
  }

  // ── Short validity cache ──
  //
  // Every signed-in request is checked against its session row, and each agent
  // polls twice a second (incoming call + live call state) — so validation was
  // the busiest query in the system, several per second per agent. A VALID
  // session is cached for a few seconds. Revoking clears the entry at once on
  // this instance; another instance sees it within SESSION_CACHE_MS. Only
  // positive answers are cached, and the cache is bounded.

  private readonly validCache = new Map<string, { user: SessionUser; until: number; expiresAt: number }>();
  private static readonly CACHE_MAX = 10_000;

  private get cacheMs(): number {
    const n = Number(process.env.SESSION_CACHE_MS ?? 5_000);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 60_000) : 5_000;
  }

  private remember(sid: string, user: SessionUser, expiresAt: number) {
    if (this.cacheMs === 0) return;
    if (this.validCache.size >= SessionService.CACHE_MAX) {
      // Oldest insertion first — Map preserves insertion order.
      const oldest = this.validCache.keys().next().value;
      if (oldest) this.validCache.delete(oldest);
    }
    this.validCache.set(sid, { user, until: Date.now() + this.cacheMs, expiresAt });
  }

  /** Drop a user's cached sessions — call when their role or status changes. */
  forgetUser(userId: string) {
    for (const [sid, entry] of this.validCache) if (entry.user.id === userId) this.validCache.delete(sid);
  }

  /**
   * Exchange a refresh token's generation for the next one.
   *
   *  • current generation → rotate (conditional on nobody else having rotated
   *    first) and hand back the new generation;
   *  • the generation just before, within the grace window → no new rotation;
   *    hand back the current generation, so tabs that raced converge;
   *  • anything else → the token was replaced long ago and is being replayed:
   *    end the session, because we cannot tell the owner from the thief.
   */
  async rotate(sid: string, generation: number, userId: string): Promise<{ user: SessionUser; sid: string; generation: number }> {
    // Bounded: a lost race re-reads the row and is judged again, at most twice.
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = await this.prisma.authSession.findUnique({
        where: { id: sid },
        select: {
          userId: true,
          generation: true,
          rotatedAt: true,
          revokedAt: true,
          expiresAt: true,
          user: { select: { id: true, email: true, role: true, isActive: true } },
        },
      });
      const now = new Date();
      if (!s || s.userId !== userId || s.revokedAt || s.expiresAt <= now || !s.user.isActive) {
        throw new UnauthorizedException(ENDED);
      }

      if (generation === s.generation) {
        const { count } = await this.prisma.authSession.updateMany({
          where: { id: sid, revokedAt: null, generation: s.generation },
          data: { generation: s.generation + 1, rotatedAt: now, lastUsedAt: now },
        });
        if (count === 1) return { user: s.user, sid, generation: s.generation + 1 };
        continue; // someone rotated between our read and write — judge again
      }

      const justReplaced =
        generation === s.generation - 1 && !!s.rotatedAt && now.getTime() - s.rotatedAt.getTime() <= ROTATION_GRACE_MS;
      if (justReplaced) return { user: s.user, sid, generation: s.generation };

      await this.revoke(sid, 'refresh_token_reuse');
      this.logger.warn(`Refresh token reuse on session ${sid} (presented generation ${generation}, current ${s.generation}) — session revoked`);
      void this.audit(
        s.userId,
        'session_reuse_detected',
        'A refresh token that had already been replaced was used again, so the session was ended as a precaution. Sign in again; if this was not you, change the password.',
      );
      throw new UnauthorizedException(ENDED);
    }
    throw new UnauthorizedException(ENDED);
  }

  /** End one session. Idempotent. */
  async revoke(sid: string, reason: string): Promise<void> {
    this.validCache.delete(sid);
    await this.prisma.authSession
      .updateMany({ where: { id: sid, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } })
      .catch((err) => this.logger.warn(`Could not revoke session ${sid}: ${String(err)}`));
  }

  /**
   * End every live session a user has — password change, deactivation, deletion.
   * Never throws: like device revocation, a failure here must not block the
   * security change that asked for it; it is logged instead.
   */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    this.forgetUser(userId);
    try {
      const { count } = await this.prisma.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
      if (count > 0) void this.audit(userId, 'sessions_revoked', `${count} signed-in session(s) ended after ${reason}`);
      return count;
    } catch (err) {
      this.logger.warn(`Could not revoke sessions for ${userId} after ${reason}: ${String(err)}`);
      return 0;
    }
  }

  private async prune(userId: string) {
    const cutoff = new Date(Date.now() - PRUNE_AFTER_DAYS * 86_400_000);
    await this.prisma.authSession
      .deleteMany({ where: { userId, OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] } })
      .catch(() => undefined);
  }

  private async audit(userId: string, action: string, remarks: string) {
    try {
      await this.prisma.activity.create({ data: { leadId: null, userId, action, oldValue: null, newValue: null, remarks } });
    } catch {
      /* auditing must never block authentication */
    }
  }
}
