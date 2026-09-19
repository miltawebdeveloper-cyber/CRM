import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';

export type IntegrationProvider = 'openphone';

/** Friendly field → env var mapping per provider. */
const ENV_KEYS: Record<IntegrationProvider, string[]> = {
  openphone: ['OPENPHONE_API_KEY', 'OPENPHONE_BASE_URL', 'OPENPHONE_WEBHOOK_SECRET'],
};

const mask = (v?: string) => (v && v.length >= 4 ? `••••${v.slice(-4)}` : v ? '••••' : null);

/**
 * Stores integration credentials in the DB (app_settings) and mirrors them into
 * process.env at runtime, so the existing Quo/OpenPhone clients (which read
 * process.env) pick them up immediately — credentials are managed entirely from
 * the admin UI, no .env editing or restart required. Secrets are never returned
 * to the client (only configured flags + a masked hint).
 */
@Injectable()
export class IntegrationConfigService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationConfigService.name);
  /** Original .env values, captured at boot, restored when a provider is cleared. */
  private readonly original: Record<string, string | undefined> = {};

  constructor(private readonly prisma: PrismaService) {
    for (const keys of Object.values(ENV_KEYS)) for (const k of keys) this.original[k] = process.env[k];
  }

  async onModuleInit() {
    try {
      const rows = await this.prisma.appSetting.findMany({ where: { key: { startsWith: 'integration:' } } });
      for (const row of rows) Object.assign(process.env, row.value as Record<string, string>);
      if (rows.length) this.logger.log(`Applied ${rows.length} integration setting(s) from DB`);
    } catch (e) {
      this.logger.warn(`Could not load integration settings: ${(e as Error).message}`);
    }
  }

  private key(p: IntegrationProvider) {
    return `integration:${p}`;
  }

  /** Persist + apply a provider's credentials (only known keys; empties cleared). */
  async set(provider: IntegrationProvider, fields: Record<string, string | undefined>) {
    const allowed = ENV_KEYS[provider];
    const clean: Record<string, string> = {};
    for (const k of allowed) if (fields[k]?.trim()) clean[k] = fields[k]!.trim();
    await this.prisma.appSetting.upsert({
      where: { key: this.key(provider) },
      create: { key: this.key(provider), value: clean as Prisma.InputJsonValue },
      update: { value: clean as Prisma.InputJsonValue },
    });
    for (const k of allowed) process.env[k] = clean[k] ?? '';
  }

  /** Remove a provider's stored credentials and restore the original .env values. */
  async clear(provider: IntegrationProvider) {
    await this.prisma.appSetting.deleteMany({ where: { key: this.key(provider) } });
    for (const k of ENV_KEYS[provider]) process.env[k] = this.original[k] ?? '';
  }

  /** Non-secret status for the UI. */
  status() {
    const env = process.env;
    const has = (k: string) => Boolean(env[k] && env[k]!.trim());
    return {
      openphone: {
        provider: 'OpenPhone',
        configured: has('OPENPHONE_API_KEY'),
        sandbox: !has('OPENPHONE_API_KEY') || env.OPENPHONE_SANDBOX === 'true',
        baseUrl: env.OPENPHONE_BASE_URL || 'https://api.openphone.com/v1',
        apiKeyHint: mask(env.OPENPHONE_API_KEY),
      },
    };
  }
}
