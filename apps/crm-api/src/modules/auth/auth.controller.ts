import { Body, Controller, Get, Post, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, VerifyMfaDto } from './dto/auth.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
