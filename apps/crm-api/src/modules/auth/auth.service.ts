import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Availability } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { MfaService } from './mfa.service';
import { LoginDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mfa: MfaService,
  ) {}

  async login(dto: LoginDto) {
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

    // Login flips the user back to Online and stamps the login time (drives the
    // no-login auto-reassignment cron).
    await this.prisma.user.update({
      where: { id: user.id },
      data: { availability: Availability.online, availabilityReason: null, lastLoginAt: new Date() },
    });

    return this.issueTokens(user.id, user.email, user.role);
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
    return { mfaEnabled: true };
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
