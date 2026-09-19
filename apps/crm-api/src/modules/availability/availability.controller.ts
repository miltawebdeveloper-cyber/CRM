import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { AvailabilityService } from './availability.service.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';

@ApiTags('availability')
@ApiBearerAuth()
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.availability.status(user.id);
  }

  // Mark offline (Leave / Holiday / Unavailable). Status only — the rep keeps
  // their leads; automatic reassignment was removed (see the service).
  @Post('offline')
  offline(@CurrentUser() user: AuthUser, @Body('reason') reason?: string) {
    return this.availability.setOffline(user.id, reason);
  }

  @Post('online')
  online(@CurrentUser() user: AuthUser) {
    return this.availability.setOnline(user.id);
  }

  // Logout / end-of-day — offline with no reason attached.
  @Post('sign-out')
  signOut(@CurrentUser() user: AuthUser) {
    return this.availability.signOut(user.id);
  }

  // Admin override — set another user's availability from the Users page.
  // A status flip either way; it does not move that user's leads.
  @Roles(Role.admin)
  @Post('user/:userId')
  adminSet(
    @Param('userId') userId: string,
    @Body('online') online: boolean,
    @Body('reason') reason?: string,
  ) {
    return this.availability.adminSetAvailability(userId, online, reason);
  }

  // Historical reassigned-work feed. Read-only: nothing writes to it now that
  // automatic reassignment is gone, and the dashboard panel hides when it's empty.
  @Get('inbox')
  inbox(@CurrentUser() user: AuthUser) {
    return this.availability.inbox(user.id);
  }

  @Post('inbox/:id/ack')
  ack(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.availability.acknowledge(id, user.id);
  }
}
