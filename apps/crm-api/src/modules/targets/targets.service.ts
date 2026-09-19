import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { UpsertTargetDto, ListTargetsQueryDto } from './dto/target.dto.js';

@Injectable()
export class TargetsService {
  constructor(private readonly prisma: PrismaService) {}

  // MET-003 — per-city targets, filterable
  findAll(query: ListTargetsQueryDto) {
    return this.prisma.target.findMany({
      where: { timezone: query.timezone, state: query.state },
      orderBy: [{ timezone: 'asc' }, { state: 'asc' }, { city: 'asc' }],
    });
  }

  // Admin sets/updates a city target (unique on state+city+timezone)
  upsert(dto: UpsertTargetDto, userId: string) {
    return this.prisma.target.upsert({
      where: {
        state_city_timezone: { state: dto.state, city: dto.city, timezone: dto.timezone },
      },
      create: { ...dto, setById: userId },
      update: { monthlyTarget: dto.monthlyTarget, setById: userId },
    });
  }

  async remove(id: string) {
    const target = await this.prisma.target.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Target not found');
    await this.prisma.target.delete({ where: { id } });
    return { success: true };
  }
}
