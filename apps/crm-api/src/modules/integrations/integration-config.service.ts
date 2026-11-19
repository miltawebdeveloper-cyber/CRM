import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
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

  /**
   * Keep every instance's runtime config in step with the database.
   *
   * `set`/`clear` apply a change to `process.env` on the instance that served
   * the admin's request — and only there. With more than one API instance the
   * others kept using the old key until they restarted. Re-reading the rows on a
   * short interval converges all of them within ~30 s. Cheap: one indexed read
   * of a handful of rows, and env is only touched when a value differs.
   */
  @Interval(30_000)
  async syncFromDb() {
    let rows: { key: string; value: unknown }[];
    try {
      rows = await this.prisma.appSetting.findMany({ where: { key: { startsWith: 'integration:' } } });
    } catch {
      return; // database blip — keep what we have, try again next tick
    }
    let changed = 0;
    for (const provider of Object.keys(ENV_KEYS) as IntegrationProvider[]) {
      const row = rows.find((r) => r.key === this.key(provider));
      const stored = (row?.value ?? null) as Record<string, string> | null;
      for (const k of ENV_KEYS[provider]) {
        // Same semantics as set() (stored row: its value or blank) and clear()
        // (no row: the value the process booted with).
        const want = stored ? (stored[k] ?? '') : (this.original[k] ?? '');
        if ((process.env[k] ?? '') !== want) {
          process.env[k] = want;
          changed++;
        }
      }
    }
    if (changed) this.logger.log(`Integration settings changed elsewhere — applied ${changed} value(s) from the database`);
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
