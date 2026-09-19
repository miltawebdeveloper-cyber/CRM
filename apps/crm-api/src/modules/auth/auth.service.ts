import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { Request, Response } from 'express';
import { Availability } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MfaService } from './mfa.service.js';
import { LoginOtpService } from './login-otp.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';
import { LoginDto } from './dto/auth.dto.js';

/** `jane.doe@example.com` → `ja••••@example.com`, so the UI can say where the code went. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '••••';
  const head = local.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mfa: MfaService,
    private readonly otp: LoginOtpService,
    private readonly devices: TrustedDeviceService,
  ) {}

  async login(dto: LoginDto, req: Request, res: Response) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    // SEC-005 — bcrypt compare; generic error to avoid user enumeration
    const ok = user && (await bcrypt.compare(dto.password, user.passwordHash));
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
        return this.completeLogin(user.id, user.email, user.role);
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

    return this.completeLogin(user.id, user.email, user.role);
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
      this.completeLogin(user.id, user.email, user.role),
    ]);
    if (trustedUntil) {
      void this.audit(user.id, 'trusted_device_added', `Device trusted until ${trustedUntil.toISOString().slice(0, 10)} — OTP will be skipped here`);
    }

    return { ...tokens, trustedUntil };
  }

  /** Shared tail of a successful login, whichever gate it came through. */
  private async completeLogin(id: string, email: string, role: string) {
    // Login flips the user back to Online and stamps the login time (drives the
    // no-login auto-reassignment cron).
    await this.prisma.user.update({
      where: { id },
      data: { availability: Availability.online, availabilityReason: null, lastLoginAt: new Date() },
    });

    return this.issueTokens(id, email, role);
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
    return user;
  }

  async refresh(refreshToken: string) {
    try {
      const payload = await this.jwt.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh-secret',
      });
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || !user.isActive) throw new UnauthorizedException();
      return this.issueTokens(user.id, user.email, user.role);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  // ── MFA enrolment ────────────────────────────────────────
  async beginMfaSetup(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const secret = this.mfa.generateSecret();
    // store secret but keep disabled until first verify
    await this.prisma.user.update({ where: { id: userId }, data: { mfaSecret: secret } });
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

  private async issueTokens(sub: string, email: string, role: string) {
    const payload = { sub, email, role };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access-secret',
        expiresIn: (process.env.JWT_ACCESS_TTL ?? '15m') as JwtSignOptions['expiresIn'],
      }),
      this.jwt.signAsync(payload, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh-secret',
        expiresIn: (process.env.JWT_REFRESH_TTL ?? '7d') as JwtSignOptions['expiresIn'],
      }),
    ]);
    return { accessToken, refreshToken, user: { id: sub, email, role } };
  }
}
