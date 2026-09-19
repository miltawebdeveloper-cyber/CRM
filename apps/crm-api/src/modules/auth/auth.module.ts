import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { JwtStrategy } from './jwt.strategy.js';
import { MfaService } from './mfa.service.js';
import { LoginOtpService } from './login-otp.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';
import { MailModule } from '../mail/mail.module.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';

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
