import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChatDto {
  @ApiProperty({ example: 'What is Form 1099?', maxLength: 2000 })
  @IsString()
  @MinLength(1)
  // Bounded: every question is stored (AiTrainingSession), and without a cap a
  // single request could write megabytes into that table.
  @MaxLength(2000)
  question: string;
}
