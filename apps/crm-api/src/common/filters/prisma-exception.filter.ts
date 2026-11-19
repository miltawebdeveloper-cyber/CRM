import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Database errors as the HTTP answers they actually are.
 *
 * Without this, every Prisma error reached the client as a bare 500 "Internal
 * server error": a duplicate email, an update of a row someone else just
 * deleted, a malformed id in the URL (`GET /leads/abc`). The client couldn't
 * tell its own mistake from a server fault, and every one of them was logged
 * as a crash, burying the real ones.
 *
 * Matched by `name` + `code` rather than `instanceof`, so it works whichever
 * copy of the Prisma runtime threw.
 */
export function mapPrismaError(err: unknown): HttpException | null {
  const e = err as { name?: string; code?: string; meta?: { target?: unknown } };
  if (!e?.name?.startsWith('PrismaClient') || typeof e.code !== 'string') return null;
  switch (e.code) {
    case 'P2002': {
      const target = Array.isArray(e.meta?.target) ? ` (${(e.meta!.target as string[]).join(', ')})` : '';
      return new ConflictException(`A record with that value already exists${target}`);
    }
    case 'P2025':
      return new NotFoundException('Record not found');
    case 'P2003':
    case 'P2014':
      return new ConflictException('That record is still referenced by other data');
    // P2007 is what the pg driver adapter raises for a malformed uuid; P2023 is
    // the same mistake from the other engines.
    case 'P2007':
    case 'P2023':
      return new BadRequestException('Invalid identifier or value');
    default:
      return null;
  }
}

@Catch()
export class PrismaExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('PrismaExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const mapped = mapPrismaError(exception);
    if (mapped) {
      this.logger.debug(`${(exception as { code?: string }).code} → ${mapped.getStatus()}`);
      return super.catch(mapped, host);
    }
    return super.catch(exception, host);
  }
}
