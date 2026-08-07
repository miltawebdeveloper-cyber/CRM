import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req, Res, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, VerifyMfaDto, VerifyOtpDto, ResendOtpDto, OtpSettingsDto } from './dto/auth.dto';
import { LoginOtpService } from './login-otp.service';
import { TrustedDeviceService } from './trusted-device.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@crm/database';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: LoginOtpService,
    private readonly devices: TrustedDeviceService,
  ) {}

  // SEC-008 — login limited to 20 attempts / 15 min / IP
  @Public()
  @Throttle({ default: { limit: 20, ttl: 15 * 60 * 1000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // req/res: the trusted-device cookie decides whether an OTP is needed at all.
    return this.auth.login(dto, req, res);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  /**
   * The one figure the sign-in screen shows about this workspace: how many
   * people use it.
   *
   * Public because the page that reads it is — there is no token yet. That
   * makes this a deliberate, and deliberately small, disclosure: a COUNT of
   * active users and nothing else. No names, no emails, no roles, nothing that
   * says who they are or what they can do, so it tells an attacker the size of
   * the room and not a single door in it.
   *
   * Rate-limited like the other public routes, and served from a short cache in
   * the service, so it cannot be used to watch the number move in real time —
   * which is the only thing a count on its own could otherwise be worth.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 15 * 60 * 1000 } })
  @Get('workspace-stats')
  workspaceStats() {
    return this.auth.workspaceStats();
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser('id') userId: string) {
    return this.auth.me(userId);
  }

  // LGN-007 — logout is stateless (client discards tokens). Endpoint kept for
  // audit logging / future refresh-token revocation list.
  //
  // It deliberately does NOT touch the trusted-device cookie: device trust
  // outlives the session, so signing out and back in on the same browser must
  // not cost the user another OTP. Dropping trust is an explicit revoke.
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(200)
  logout() {
    return { success: true };
  }

  /**
   * Exchange a login OTP for tokens. Public — the caller has passed the password
   * check but has no token yet, which is the whole point of the second factor.
   * Rate-limited harder than login: this is the endpoint a 6-digit code is
   * guessable against.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // A passed code also mints the trusted-device cookie on this response.
    return this.auth.verifyLoginOtp(dto.challengeId, dto.code, req, res);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @Post('otp/resend')
  @HttpCode(200)
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.otp.resend(dto.challengeId);
  }

  /** Authentication Settings — admin only. */
  @ApiBearerAuth()
  @Roles(Role.admin)
  @Get('otp-settings')
  async otpSettings() {
    return { ...(await this.otp.getSettings()), mailReady: this.otp.mailReady };
  }

  @ApiBearerAuth()
  @Roles(Role.admin)
  @Put('otp-settings')
  async saveOtpSettings(@Body() dto: OtpSettingsDto) {
    return { ...(await this.otp.saveSettings(dto)), mailReady: this.otp.mailReady };
  }

  // ── Trusted devices ──────────────────────────────────────
  // Every user manages their own; admins additionally see and revoke everyone's.

  /** Devices trusted for the caller. `current: true` marks the browser in use. */
  @ApiBearerAuth()
  @Get('devices')
  myDevices(@CurrentUser('id') userId: string, @Req() req: Request) {
    return this.devices.list(userId, this.devices.currentDeviceId(req));
  }

  /** Admin Trusted Devices panel — every user's devices, newest activity first. */
  @ApiBearerAuth()
  @Roles(Role.admin)
  @Get('devices/all')
  allDevices(@Req() req: Request) {
    return this.devices.listAll(this.devices.currentDeviceId(req));
  }

  /**
   * Revoke every device — the caller's own, or (admin only) another user's via
   * ?userId=. The next login from any of them needs a fresh code.
   */
  @ApiBearerAuth()
  @Delete('devices')
  @HttpCode(200)
  revokeDevices(@CurrentUser() user: AuthUser, @Query('userId') userId?: string) {
    const target = userId && userId !== user.id ? userId : user.id;
    if (target !== user.id && user.role !== Role.admin) {
      throw new ForbiddenException('Only an administrator can revoke another user’s devices');
    }
    return this.devices.revokeAll(target);
  }

  @ApiBearerAuth()
  @Delete('devices/:id')
  @HttpCode(200)
  revokeDevice(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.devices.revoke(id, user);
  }

  @ApiBearerAuth()
  @Post('mfa/setup')
  @HttpCode(200)
  setupMfa(@CurrentUser('id') userId: string) {
    return this.auth.beginMfaSetup(userId);
  }

  @ApiBearerAuth()
  @Post('mfa/confirm')
  @HttpCode(200)
  confirmMfa(@CurrentUser('id') userId: string, @Body() dto: VerifyMfaDto) {
    return this.auth.confirmMfa(userId, dto.token);
  }

  /**
   * Turn MFA off. Needs a current code, like enabling does — and like the OTP
   * endpoints, it is rate-limited, because this is the one route that removes a
   * factor rather than adding one.
   */
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @Post('mfa/disable')
  @HttpCode(200)
  disableMfa(@CurrentUser('id') userId: string, @Body() dto: VerifyMfaDto) {
    return this.auth.disableMfa(userId, dto.token);
  }
}
