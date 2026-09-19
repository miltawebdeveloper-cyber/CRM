import { Injectable } from '@nestjs/common';
import { Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /** All of a user's preferences as a { key: value } map. */
  async getAll(userId: string): Promise<Record<string, unknown>> {
    const rows = await this.prisma.userPreference.findMany({ where: { userId } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Upsert a single preference. */
  async set(userId: string, key: string, value: unknown) {
    const json = (value ?? Prisma.JsonNull) as Prisma.InputJsonValue;
    await this.prisma.userPreference.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, value: json },
      update: { value: json },
    });
    return { ok: true };
  }

  /** Remove a single preference (reset to default). */
  async remove(userId: string, key: string) {
    await this.prisma.userPreference.deleteMany({ where: { userId, key } });
    return { ok: true };
  }
}
