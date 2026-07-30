import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SnoozeCallbackDto {
  /**
   * Minutes rather than a target instant: the rep is choosing "remind me in a
   * bit", and a duration can't be knocked out by a clock difference between
   * their browser and the server the way an absolute time can.
   */
  @ApiProperty({ minimum: 1, maximum: 1440, example: 15, description: 'Minutes to silence the reminder for' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  minutes!: number;
}
