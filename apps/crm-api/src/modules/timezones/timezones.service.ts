import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TimezonesCacheService } from './timezones-cache.service.js';
import { CreateTimezoneDto, UpdateTimezoneDto } from './dto/timezone.dto.js';

@Injectable()
export class TimezonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: TimezonesCacheService,
  ) {}

  /** Full list, inactive included (ordered). */
  listAll() {
    return this.prisma.timezoneOption.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async create(dto: CreateTimezoneDto) {
    const code = dto.code.trim();
    if (!code) throw new BadRequestException('code is required');
    const exists = await this.prisma.timezoneOption.findUnique({ where: { code } });
    if (exists) throw new BadRequestException(`A time zone with code "${code}" already exists`);
    await this.assertCountry(dto.countryCode);
    const max = await this.prisma.timezoneOption.aggregate({ _max: { sortOrder: true } });
    const created = await this.prisma.timezoneOption.create({
      data: {
        code,
        label: dto.label,
        ianaZone: dto.ianaZone,
        countryCode: dto.countryCode || null,
        sortOrder: dto.sortOrder ?? (max._max.sortOrder ?? 0) + 10,
        isActive: dto.isActive ?? true,
      },
    });
    // The admin who just made this must see it in the same request cycle,
    // not wait for the cache's 15s safety-net timer.
    await this.cache.refresh();
    return created;
  }

  async update(id: string, dto: UpdateTimezoneDto) {
    await this.assertCountry(dto.countryCode);
    try {
      const updated = await this.prisma.timezoneOption.update({
        where: { id },
        data: {
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.countryCode !== undefined ? { countryCode: dto.countryCode || null } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      if (dto.countryCode !== undefined) {
        // A country whose default was this zone can't keep it once the zone
        // belongs elsewhere — that default would fill in a mismatched pair.
        await this.prisma.country.updateMany({
          where: { defaultTimezone: updated.code, NOT: { code: updated.countryCode ?? '' } },
          data: { defaultTimezone: null },
        });
      }
      await this.cache.refresh();
      return updated;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Time zone not found');
      }
      throw e;
    }
  }

  private async assertCountry(code?: string | null) {
    if (!code) return;
    const found = await this.prisma.country.findUnique({ where: { code } });
    if (!found) throw new BadRequestException(`Unknown country "${code}"`);
  }
}
