import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Provider-level SMS payload — the shape OpenPhone itself takes (explicit from,
 * to and content).
 *
 * Named apart from the app-facing `SendSmsDto` in the communications module,
 * which sends to a LEAD and only carries a body. Both were called `SendSmsDto`,
 * and Swagger keys schemas by class name, so the two collided: the API docs
 * showed one shape for both endpoints and Nest warned the clash will be a hard
 * error in its next major version.
 */
export class SendOpenPhoneSmsDto {
  @ApiProperty({ description: 'OpenPhone number or id to send from' })
  @IsString()
  from: string;

  @ApiProperty({ description: 'Recipient phone number (E.164)' })
  @IsString()
  to: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  content: string;
}
