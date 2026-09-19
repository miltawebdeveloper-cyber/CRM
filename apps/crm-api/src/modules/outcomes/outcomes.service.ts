import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateOutcomeDto, UpdateOutcomeDto } from './dto/outcome.dto.js';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

@Injectable()
export class OutcomesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active outcomes for pickers/filters (ordered). */
  listActive() {
    return this.prisma.outcome.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  }

  /** Full list for the admin screen (includes inactive). */
  listAll() {
    return this.prisma.outcome.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  /** Resolve one outcome by its slug (used when ending a call). */
  bySlug(slug: string) {
    return this.prisma.outcome.findUnique({ where: { slug } });
  }

  async create(dto: CreateOutcomeDto) {
    const slug = dto.slug ? slugify(dto.slug) : slugify(dto.name);
    if (!slug) throw new BadRequestException('Could not derive a slug from the name');
    const exists = await this.prisma.outcome.findUnique({ where: { slug } });
    if (exists) throw new BadRequestException(`An outcome with slug "${slug}" already exists`);
    const max = await this.prisma.outcome.aggregate({ _max: { sortOrder: true } });
    return this.prisma.outcome.create({
      data: {
        slug,
        name: dto.name,
        color: dto.color ?? '#75766a',
        schedulesCallback: dto.schedulesCallback ?? false,
        schedulesZoom: dto.schedulesZoom ?? false,
        leadStatus: dto.leadStatus ?? null,
        category: dto.category ?? null,
        sortOrder: dto.sortOrder ?? (max._max.sortOrder ?? 0) + 10,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(id: string, dto: UpdateOutcomeDto) {
    try {
      return await this.prisma.outcome.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          ...(dto.schedulesCallback !== undefined ? { schedulesCallback: dto.schedulesCallback } : {}),
          ...(dto.schedulesZoom !== undefined ? { schedulesZoom: dto.schedulesZoom } : {}),
          ...(dto.leadStatus !== undefined ? { leadStatus: dto.leadStatus } : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Outcome not found');
      }
      throw e;
    }
  }

  async remove(id: string) {
    try {
      await this.prisma.outcome.delete({ where: { id } });
      return { success: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Outcome not found');
      }
      throw e;
    }
  }
}
