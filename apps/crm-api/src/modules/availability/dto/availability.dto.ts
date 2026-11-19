import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The availability routes read `online` / `reason` straight off the body with
 * `@Body('…')`, which skips validation entirely: `online` could be the string
 * "false" (truthy — the opposite of what was sent) and `reason` any size.
 */
export class GoOfflineDto {
  @ApiPropertyOptional({ example: 'Lunch' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class AdminSetAvailabilityDto {
  @ApiProperty()
  @IsBoolean()
  online: boolean;

  @ApiPropertyOptional({ example: 'Leave' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
