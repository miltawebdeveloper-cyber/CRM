import { Body, Controller, Get, Post, Put, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, VerifyMfaDto, VerifyOtpDto, ResendOtpDto, OtpSettingsDto } from './dto/auth.dto';
import { LoginOtpService } from './login-otp.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@crm/database';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: LoginOtpService,
  ) {}

  // SEC-008 — login limited to 20 attempts / 15 min / IP
  @Public()
  @Throttle({ default: { limit: 20, ttl: 15 * 60 * 1000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser('id') userId: string) {
    return this.auth.me(userId);
  }

  // LGN-007 — logout is stateless (client discards tokens). Endpoint kept for
  // audit logging / future refresh-token revocation list.
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
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyLoginOtp(dto.challengeId, dto.code);
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
}
