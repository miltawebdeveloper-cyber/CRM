import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { TrustedDeviceService } from '../auth/trusted-device.service';
import { CreateUserDto, UpdateUserDto, ListUsersQueryDto } from './dto/user.dto';

// Never leak secrets — select excludes passwordHash / mfaSecret.
const SAFE_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  mfaEnabled: true,
  availability: true,
  shiftStart: true,
  openphoneNumber: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: TrustedDeviceService,
  ) {}

  /**
   * A caller ID (OpenPhone number) identifies exactly one employee to the customer,
   * so it must be unique. Rejects a number already assigned to another user with a
   * clear message, before the DB's unique constraint would raise a raw error.
   */
  private async assertNumberAvailable(openphoneNumber: string, exceptUserId?: string) {
    const clash = await this.prisma.user.findFirst({
      where: { openphoneNumber, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
      select: { name: true },
    });
    if (clash) {
      throw new ConflictException(`Caller ID ${openphoneNumber} is already assigned to ${clash.name}. Each user needs a unique number.`);
    }
  }

  // LGN-012 — admin user list, filterable by role/status
  async findAll(query: ListUsersQueryDto) {
    return this.prisma.user.findMany({
      where: { role: query.role, isActive: query.isActive },
      select: SAFE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // LGN-009 — create user
  async create(dto: CreateUserDto) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException('Email already in use');

    const number = dto.openphoneNumber?.trim();
    if (number) await this.assertNumberAvailable(number);

    const passwordHash = await bcrypt.hash(dto.password, 12); // SEC-005
    return this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        role: dto.role,
        passwordHash,
        ...(number ? { openphoneNumber: number } : {}),
        ...(dto.role === 'employee' ? { employee: { create: {} } } : {}),
      },
      select: SAFE_SELECT,
    });
  }

  // LGN-010 — edit user (name/email/role/password)
  async update(id: string, dto: UpdateUserDto) {
    await this.findOne(id);
    // A non-empty number must be free (not held by another user) before assigning.
    if (dto.openphoneNumber !== undefined && dto.openphoneNumber.trim()) {
      await this.assertNumberAvailable(dto.openphoneNumber.trim(), id);
    }
    const data: Prisma.UserUpdateInput = {
      name: dto.name,
      email: dto.email,
      role: dto.role,
      isActive: dto.isActive,
      ...(dto.shiftStart !== undefined ? { shiftStart: dto.shiftStart.trim() || null } : {}),
      ...(dto.openphoneNumber !== undefined ? { openphoneNumber: dto.openphoneNumber.trim() || null } : {}),
    };
    if (dto.password) data.passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.update({ where: { id }, data, select: SAFE_SELECT });
    // A new password must not leave devices behind that can still skip the OTP —
    // otherwise the reset doesn't actually lock out whoever had the old one.
    if (dto.password) await this.devices.revokeOnPasswordChange(id);
    return user;
  }

  // LGN-011 — deactivate (soft); deactivated users cannot login
  async deactivate(id: string) {
    await this.findOne(id);
    return this.prisma.user.update({
      where: { id },
      data: { isActive: false },
      select: SAFE_SELECT,
    });
  }
}
