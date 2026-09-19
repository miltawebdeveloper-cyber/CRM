import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { Roles } from '../../common/decorators/roles.decorator.js';

/** Integration status for the Settings page. Returns booleans only — never the
 * secret values themselves (DEP-004 / SEC). */
@ApiTags('config')
@ApiBearerAuth()
@Controller('config')
export class ConfigController {
  @Roles(Role.admin)
  @Get('status')
  status() {
    const env = process.env;
    const has = (k: string) => Boolean(env[k] && env[k]!.trim());
    return {
      database: { provider: 'PostgreSQL', configured: has('DATABASE_URL') },
      calling: {
        provider: 'Twilio',
        configured: has('TWILIO_ACCOUNT_SID') && has('TWILIO_AUTH_TOKEN'),
      },
      ai: {
        provider: env.LLM_PROVIDER ?? 'anthropic',
        model: env.ANTHROPIC_MODEL ?? null,
        configured: has('ANTHROPIC_API_KEY') || has('OPENAI_API_KEY'),
      },
      quo: {
        // Lead → contact sync now rides the OpenPhone key (Quo == OpenPhone).
        configured: has('OPENPHONE_API_KEY'),
        sandbox: !has('OPENPHONE_API_KEY') || env.OPENPHONE_SANDBOX === 'true',
      },
      openphone: {
        provider: 'OpenPhone',
        configured: has('OPENPHONE_API_KEY'),
        sandbox: !has('OPENPHONE_API_KEY') || env.OPENPHONE_SANDBOX === 'true',
      },
      storage: { provider: 'S3', configured: has('S3_ACCESS_KEY_ID') && has('S3_BUCKET') },
      redis: { configured: has('REDIS_URL') },
    };
  }
}
