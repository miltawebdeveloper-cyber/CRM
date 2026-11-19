import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { mapPrismaError } from './prisma-exception.filter.js';

/** Database errors must reach the client as what they are, not as a 500. */
describe('mapPrismaError', () => {
  const prismaError = (code: string, meta?: unknown) => Object.assign(new Error(code), { name: 'PrismaClientKnownRequestError', code, meta });

  it('maps a unique violation to 409, naming the field', () => {
    const e = mapPrismaError(prismaError('P2002', { target: ['email'] }));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e?.message).toContain('email');
  });

  it('maps a missing record to 404', () => {
    expect(mapPrismaError(prismaError('P2025'))).toBeInstanceOf(NotFoundException);
  });

  it('maps a malformed id (pg adapter P2007, other engines P2023) to 400', () => {
    expect(mapPrismaError(prismaError('P2007'))).toBeInstanceOf(BadRequestException);
    expect(mapPrismaError(prismaError('P2023'))).toBeInstanceOf(BadRequestException);
  });

  it('leaves everything else alone — unknown codes and non-Prisma errors stay 500s', () => {
    expect(mapPrismaError(prismaError('P1001'))).toBeNull();
    expect(mapPrismaError(new Error('boom'))).toBeNull();
    expect(mapPrismaError(Object.assign(new Error('x'), { code: 'P2002' }))).toBeNull();
  });
});
