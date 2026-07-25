import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { AvailabilityService } from './availability.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('availability')
@ApiBearerAuth()
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.availability.status(user.id);
  }

  // Mark offline (Leave / Holiday / Unavailable) → auto-reassign pending work.
  @Post('offline')
  offline(@CurrentUser() user: AuthUser, @Body('reason') reason?: string) {
    return this.availability.setOffline(user.id, reason);
  }

  @Post('online')
  online(@CurrentUser() user: AuthUser) {
    return this.availability.setOnline(user.id);
  }

  // Logout / end-of-day — sets offline status only (no reassignment).
  @Post('sign-out')
  signOut(@CurrentUser() user: AuthUser) {
    return this.availability.signOut(user.id);
  }

  // Admin override — set another user's availability from the Users page.
  // Offline reassigns that user's pending work, same as if they went offline.
  @Roles(Role.admin)
  @Post('user/:userId')
  adminSet(
    @Param('userId') userId: string,
    @Body('online') online: boolean,
    @Body('reason') reason?: string,
  ) {
    return this.availability.adminSetAvailability(userId, online, reason);
  }

  // Reassigned-work feed for the current user's dashboard.
  @Get('inbox')
  inbox(@CurrentUser() user: AuthUser) {
    return this.availability.inbox(user.id);
  }

  @Post('inbox/:id/ack')
  ack(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.availability.acknowledge(id, user.id);
  }
}
