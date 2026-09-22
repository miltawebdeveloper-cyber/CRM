import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min, MinLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'admin@crm.local' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Passw0rd!' })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({ description: '6-digit TOTP code (required if MFA enabled)' })
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'mfaToken must be a 6-digit code' })
  mfaToken?: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken: string;
}

export class VerifyMfaDto {
  @ApiProperty({ description: '6-digit TOTP code from the authenticator app' })
  @Matches(/^\d{6}$/)
  token: string;
}

/** Exchange a verified login OTP for tokens. */
export class VerifyOtpDto {
  @ApiProperty({ description: 'Challenge id returned by /auth/login' })
  @IsString()
  challengeId: string;

  @ApiProperty({ description: '6-digit code from the OTP email' })
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit number' })
  code: string;
}

export class ResendOtpDto {
  @ApiProperty()
  @IsString()
  challengeId: string;
}

/** Admin-configurable OTP policy (Authentication Settings). */
export class OtpSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Minutes before a code expires (1–60)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  expiryMinutes?: number;

  @ApiPropertyOptional({ description: 'Incorrect attempts allowed per code (1–10)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;

  @ApiPropertyOptional({ description: 'Seconds before a resend is allowed (15–600)' })
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(600)
  resendSeconds?: number;

  @ApiPropertyOptional({ description: 'Skip the OTP on devices that have already passed one' })
  @IsOptional()
  @IsBoolean()
  trustDeviceEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Days a device stays trusted before a new code is required (1–365)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  trustDeviceDays?: number;
}
