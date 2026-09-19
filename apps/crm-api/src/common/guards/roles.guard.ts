import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@crm/database';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

/**
 * RBAC guard (LGN-006 / SEC-001). Runs after JwtAuthGuard; enforces @Roles().
 * Routes without @Roles() are allowed for any authenticated user.
 * "Own-records-only" rules (caller sees only assigned leads) are enforced with
 * row-level filtering in the relevant services, not here.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Insufficient role for this action');
    }
    return true;
  }
}
