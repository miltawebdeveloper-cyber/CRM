import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { Request, Response } from 'express';
import { Availability } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { MfaService } from './mfa.service';
import { LoginOtpService } from './login-otp.service';
import { TrustedDeviceService } from './trusted-device.service';
import { LoginDto } from './dto/auth.dto';

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
        await this.audit(user.id, 'trusted_device_login', 'Signed in from a trusted device — OTP skipped');
        return this.completeLogin(user.id, user.email, user.role);
      }
      // Cookie present but not honoured (expired, revoked, or another account's):
      // drop it rather than leaving a dead credential in the browser.
      if (this.devices.currentDeviceId(req)) this.devices.clearCookie(res);

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
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new UnauthorizedException('Account deactivated');

    // A passed code buys this browser a trust window — including a fresh one when
    // the previous window had simply run out.
    const s = await this.otp.getSettings();
    let trustedUntil: Date | null = null;
    if (s.trustDeviceEnabled) {
      trustedUntil = await this.devices.remember(req, res, user.id, s.trustDeviceDays);
      await this.audit(user.id, 'trusted_device_added', `Device trusted until ${trustedUntil.toISOString().slice(0, 10)} — OTP will be skipped here`);
    }

    return { ...(await this.completeLogin(user.id, user.email, user.role)), trustedUntil };
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
