import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateCountryDto, UpdateCountryDto } from './dto/country.dto.js';

@Injectable()
export class CountriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active countries for pickers/filters (ordered). */
  listActive() {
    return this.prisma.country.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  }

  /** Full list for the admin screen (includes inactive). */
  listAll() {
    return this.prisma.country.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async create(dto: CreateCountryDto) {
    const code = (dto.code ?? dto.name).trim();
    if (!code) throw new BadRequestException('Could not derive a code from the name');
    const exists = await this.prisma.country.findUnique({ where: { code } });
    if (exists) throw new BadRequestException(`A country with code "${code}" already exists`);
    const max = await this.prisma.country.aggregate({ _max: { sortOrder: true } });
    return this.prisma.country.create({
      data: {
        code,
        name: dto.name,
        sortOrder: dto.sortOrder ?? (max._max.sortOrder ?? 0) + 10,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(id: string, dto: UpdateCountryDto) {
    try {
      return await this.prisma.country.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Country not found');
      }
      throw e;
    }
  }
}
