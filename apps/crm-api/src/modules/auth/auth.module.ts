import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { MfaService } from './mfa.service';
import { LoginOtpService } from './login-otp.service';
import { TrustedDeviceService } from './trusted-device.service';
import { MailModule } from '../mail/mail.module';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  imports: [PassportModule, JwtModule.register({}), MailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    MfaService,
    LoginOtpService,
    TrustedDeviceService,
    JwtStrategy,
    // Global auth + RBAC. Order matters: authenticate, then check role.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, TrustedDeviceService],
})
export class AuthModule {}
