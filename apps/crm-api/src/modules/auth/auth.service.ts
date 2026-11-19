import { Injectable, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { Availability } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MfaService } from './mfa.service.js';
import { LoginOtpService } from './login-otp.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';
import { SessionService } from './session.service.js';
import { LoginDto } from './dto/auth.dto.js';
import { jwtAccessSecret, jwtRefreshSecret } from '../../common/env.js';
import { businessIana } from '../../common/timezone.js';

/** Claims a refresh token carries. `gen` is the session generation it belongs to. */
interface RefreshClaims {
  sub: string;
  sid?: string;
  gen?: number;
  typ?: string;
}

/** `jane.doe@example.com` → `ja••••@example.com`, so the UI can say where the code went. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '••••';
  const head = local.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

/**
 * A bcrypt hash of a random value nobody knows, at the same cost as real
 * passwords (12, see UsersService), compared against when the email is unknown
 * so both outcomes take the same time. Computed once, at module load.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(randomBytes(24).toString('hex'), 12);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mfa: MfaService,
    private readonly otp: LoginOtpService,
    private readonly devices: TrustedDeviceService,
    private readonly sessions: SessionService,
  ) {}

  async login(dto: LoginDto, req: Request, res: Response) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    // SEC-005 — bcrypt compare; generic error to avoid user enumeration. An
    // unknown email still pays for a full compare (against a throwaway hash):
    // skipping it made "no such account" answer ~100ms faster than "wrong
    // password", which told anyone timing the endpoint which emails exist.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!ok || !user) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Account deactivated'); // LGN-011

    // MFA gate
    if (user.mfaEnabled) {
      if (!dto.mfaToken) {
        return { mfaRequired: true };
      }
      if (!user.mfaSecret || !this.mfa.verify(dto.mfaToken, user.mfaSecret)) {
        throw new UnauthorizedException('Invalid MFA code');
      }
      // A secret stored before encryption was switched on is sealed now, on its
      // first successful use — no migration step, no re-enrolment.
      if (this.mfa.needsSealing(user.mfaSecret)) {
        const sealed = this.mfa.seal(this.mfa.open(user.mfaSecret));
        void this.prisma.user.update({ where: { id: user.id }, data: { mfaSecret: sealed } }).catch(() => undefined);
      }
    }

    // Email-OTP gate. The password alone no longer completes a login: a code is
    // mailed to the configured address and exchanged for tokens by /auth/otp/verify.
    // No tokens are issued here, so a stolen password gets nothing on its own.
    const otp = await this.otp.getSettings();
    if (otp.enabled) {
      // …unless this browser already answered a code and is still inside its trust
      // window. That is the whole point of trusted devices: one code per device
      // per window, so signing out and back in doesn't cost another one.
      if (otp.trustDeviceEnabled && (await this.devices.isTrusted(req, user.id))) {
        // Written behind the response: the audit trail is nobody's answer.
        void this.audit(user.id, 'trusted_device_login', 'Signed in from a trusted device — OTP skipped');
        return this.completeLogin(user.id, user.email, user.role, req);
      }
      // A cookie is present but this user isn't trusted by it — expired, revoked,
      // or it only carries other accounts. Drop THIS user's entry and leave the
      // rest: wiping the whole cookie meant one person signing in un-trusted
      // everyone else who shares the browser, so an admin and an employee account
      // on the same machine each cost the other a code on every switch.
      await this.devices.dropUser(req, res, user.id);

      const { challengeId, sentTo, resendSeconds } = await this.otp.issue(user);
      return {
        otpRequired: true as const,
        challengeId,
        // Masked — the client shows where to look without publishing the address.
        sentTo: maskEmail(sentTo),
        resendSeconds,
        // So the OTP screen can say how long this device will be remembered for.
        trustDeviceDays: otp.trustDeviceEnabled ? otp.trustDeviceDays : 0,
      };
    }

    return this.completeLogin(user.id, user.email, user.role, req);
  }

  /**
   * Exchange a verified OTP challenge for tokens. Verification is the OTP
   * service's job; this only issues once it has passed.
   */
  async verifyLoginOtp(challengeId: string, code: string, req: Request, res: Response) {
    const { userId } = await this.otp.verify(challengeId, code);
    // The account and the trust policy are unrelated lookups, so they overlap.
    const [user, s] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.otp.getSettings(),
    ]);
    if (!user || !user.isActive) throw new UnauthorizedException('Account deactivated');

    // A passed code buys this browser a trust window — including a fresh one when
    // the previous window had simply run out. Recording the device and finishing
    // the login share nothing, so they run together instead of one after the other.
    const [trustedUntil, tokens] = await Promise.all([
      s.trustDeviceEnabled ? this.devices.remember(req, res, user.id, s.trustDeviceDays) : Promise.resolve(null),
      this.completeLogin(user.id, user.email, user.role, req),
    ]);
    if (trustedUntil) {
      void this.audit(user.id, 'trusted_device_added', `Device trusted until ${trustedUntil.toISOString().slice(0, 10)} — OTP will be skipped here`);
    }

    return { ...tokens, trustedUntil };
  }

  /** Shared tail of a successful login, whichever gate it came through. */
  private async completeLogin(id: string, email: string, role: string, req?: Request) {
    // Login flips the user back to Online and stamps the login time (drives the
    // no-login auto-reassignment cron). The session row is what every token
    // issued from here on is checked against; the two writes are independent.
    const [, session] = await Promise.all([
      this.prisma.user.update({
        where: { id },
        data: { availability: Availability.online, availabilityReason: null, lastLoginAt: new Date() },
      }),
      this.sessions.create(id, req),
    ]);

    return this.issueTokens(id, email, role, session.sid, session.generation);
  }

  /**
   * How many people actively use this workspace — the figure on the sign-in
   * screen, and the only thing an unauthenticated caller can learn here.
   *
   * Active only, so a deactivated leaver stops being counted the day their
   * access is withdrawn rather than inflating the number forever.
   *
   * Cached for five minutes in memory. The point is not the database load — it
   * is one indexed COUNT — but that an endpoint anybody can call should not
   * report a live figure they could poll to watch someone being added or
   * removed. A stale count is the honest answer to a question nobody has a
   * right to ask precisely.
   */
  private workspaceStatsCache: { at: number; users: number } | null = null;

  async workspaceStats() {
    const TTL_MS = 5 * 60 * 1000;
    const now = Date.now();
    if (!this.workspaceStatsCache || now - this.workspaceStatsCache.at > TTL_MS) {
      const users = await this.prisma.user.count({ where: { isActive: true } });
      this.workspaceStatsCache = { at: now, users };
    }
    return { users: this.workspaceStatsCache.users };
  }

  /** Current user for /auth/me — includes the caller identity (name + assigned
   *  OpenPhone number) so the UI can show "you call as …" and flag an unassigned rep. */
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, openphoneNumber: true },
    });
    if (!user) throw new UnauthorizedException('Account not found');
    // The zone that defines "today" for date presets, so the browser's "Today"
    // asks for the same day the server's dashboards count (BUSINESS_TIMEZONE).
    return { ...user, businessTimezone: businessIana() };
  }

  /**
   * Exchange a refresh token for a new pair. Tokens rotate: the presented token
   * names a session generation, and `SessionService.rotate` decides whether it
   * is the current one, a just-replaced one from a racing tab, or a replay —
   * the last of which ends the session.
   */
  async refresh(refreshToken: string) {
    let claims: RefreshClaims;
    try {
      claims = await this.jwt.verifyAsync<RefreshClaims>(refreshToken, { secret: jwtRefreshSecret() });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // A token from before server-side sessions has no `sid` and cannot be
    // rotated; that browser signs in again once.
    if (claims.typ !== 'refresh' || !claims.sid || typeof claims.gen !== 'number') {
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }
    const { user, sid, generation } = await this.sessions.rotate(claims.sid, claims.gen, claims.sub);
    return this.issueTokens(user.id, user.email, user.role, sid, generation);
  }

  /**
   * End the session a refresh token belongs to. The token is the proof of
   * ownership, so this works without a live access token (one that expired just
   * before the click must still be able to sign out). Expiry is ignored for the
   * same reason; the signature is not. Anything unreadable is a no-op: logout
   * always "succeeds" from the client's point of view.
   */
  async logout(refreshToken?: string) {
    if (refreshToken) {
      try {
        const claims = await this.jwt.verifyAsync<RefreshClaims>(refreshToken, {
          secret: jwtRefreshSecret(),
          ignoreExpiration: true,
        });
        if (claims.typ === 'refresh' && claims.sid) await this.sessions.revoke(claims.sid, 'logout');
      } catch {
        /* a bad or foreign token signs nobody out */
      }
    }
    return { success: true };
  }

  // ── MFA enrolment ────────────────────────────────────────
  async beginMfaSetup(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // Refused while MFA is on. Setup used to overwrite the ACTIVE secret with a
    // new one and leave MFA enabled, so a hijacked session (an access token, no
    // second factor) could re-bind the account's MFA to the attacker's phone —
    // and the real owner was locked out. Changing device is now: disable with a
    // current code (proof of the factor), then set up again.
    if (user.mfaEnabled) {
      throw new ConflictException('MFA is already enabled. Disable it with a current code before setting it up again.');
    }
    const secret = this.mfa.generateSecret();
    // Stored (encrypted when a key is configured) but inactive until confirmed.
    await this.prisma.user.update({ where: { id: userId }, data: { mfaSecret: this.mfa.seal(secret) } });
    return { qrCode: await this.mfa.buildQrCode(user.email, secret) };
  }

  async confirmMfa(userId: string, token: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaSecret) throw new BadRequestException('MFA setup not started');
    if (!this.mfa.verify(token, user.mfaSecret)) {
      throw new UnauthorizedException('Invalid MFA code');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
    // Turning MFA on changes what guards this account, so devices trusted under
    // the old arrangement no longer stand — every browser answers a fresh code.
    await this.devices.revokeOnSecurityChange(userId, 'enabling MFA');
    await this.audit(userId, 'mfa_enabled', 'MFA enabled — trusted devices revoked');
    return { mfaEnabled: true };
  }

  /**
   * Turn MFA off. Requires a valid current code, exactly as enabling does:
   * stripping a factor is a privileged act, and without the proof a hijacked
   * session could quietly remove the protection standing in its way.
   *
   * The stored secret is cleared alongside the flag, so re-enrolling issues a
   * brand-new secret rather than silently reactivating the old one — anyone who
   * captured it while MFA was on cannot turn it back on and be trusted.
   */
  async disableMfa(userId: string, token: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaEnabled || !user.mfaSecret) throw new BadRequestException('MFA is not enabled');
    if (!this.mfa.verify(token, user.mfaSecret)) {
      throw new UnauthorizedException('Invalid MFA code');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecret: null } });
    await this.devices.revokeOnSecurityChange(userId, 'disabling MFA');
    await this.audit(userId, 'mfa_disabled', 'MFA disabled — trusted devices revoked');
    return { mfaEnabled: false };
  }

  /** Account-level audit entry (leadId null — this is not a lead event). */
  private async audit(userId: string, action: string, remarks: string) {
    try {
      await this.prisma.activity.create({ data: { leadId: null, userId, action, oldValue: null, newValue: null, remarks } });
    } catch {
      /* auditing must never block a login */
    }
  }

  private async issueTokens(sub: string, email: string, role: string, sid: string, generation: number) {
    // `typ` keeps the two token kinds from standing in for each other even if a
    // deployment ever configured the same secret for both; `sid` ties both to
    // the session row that can revoke them.
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync({ sub, email, role, sid, typ: 'access' }, {
        secret: jwtAccessSecret(),
        expiresIn: (process.env.JWT_ACCESS_TTL ?? '15m') as JwtSignOptions['expiresIn'],
      }),
      this.jwt.signAsync({ sub, sid, gen: generation, typ: 'refresh' }, {
        secret: jwtRefreshSecret(),
        expiresIn: (process.env.JWT_REFRESH_TTL ?? '7d') as JwtSignOptions['expiresIn'],
      }),
    ]);
    return { accessToken, refreshToken, user: { id: sub, email, role } };
  }
}
