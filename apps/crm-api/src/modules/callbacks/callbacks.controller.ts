import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { CallbacksService } from './callbacks.service.js';
import { CallbackRolloverService } from './callback-rollover.service.js';
import { SnoozeCallbackDto } from './dto/callback.dto.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';

/**
 * The on-screen half of callback reminders — what the browser polls to decide
 * whether to interrupt the rep, and the two ways they can quiet it.
 *
 * Completing and rescheduling are NOT here: those already exist as
 * `POST /calls/followups/lead/:id/complete` and `POST /calls/followups/lead/:id`,
 * and the popup calls those. A second pair of endpoints doing the same writes is
 * how the two would eventually stop clearing the same set of reminder stamps.
 */
@ApiTags('callbacks')
@ApiBearerAuth()
@Controller('callbacks')
export class CallbacksController {
  constructor(
    private readonly callbacks: CallbacksService,
    private readonly rollover: CallbackRolloverService,
  ) {}

  @Get('due')
  @ApiOperation({ summary: 'Callbacks due or overdue for the current user, not snoozed or dismissed' })
  due(@CurrentUser() user: AuthUser) {
    return this.callbacks.due(user.id);
  }

  @Get('today')
  @ApiOperation({ summary: "Open callbacks on today's date in the lead's zone, plus anything overdue" })
  today(@CurrentUser() user: AuthUser) {
    return this.callbacks.today(user.id);
  }

  @Post(':leadId/snooze')
  @ApiOperation({ summary: 'Silence this callback reminder for N minutes' })
  snooze(@Param('leadId') leadId: string, @Body() dto: SnoozeCallbackDto, @CurrentUser() user: AuthUser) {
    return this.callbacks.snooze(leadId, dto.minutes, { id: user.id, role: user.role });
  }

  @Post(':leadId/dismiss')
  @ApiOperation({ summary: 'Stop reminding about this callback without completing it' })
  dismiss(@Param('leadId') leadId: string, @CurrentUser() user: AuthUser) {
    return this.callbacks.dismiss(leadId, { id: user.id, role: user.role });
  }

  /**
   * Run the pending-call rollover now instead of waiting for the hourly sweep.
   *
   * The rollover is automatic and needs nobody to press anything — this exists
   * so an admin can catch the backlog up immediately after an outage, and so the
   * behaviour is testable against real data. Idempotent: it moves only calls
   * whose day has already ended, and always to a future slot.
   */
  @Roles(Role.admin)
  @Post('rollover/run')
  @ApiOperation({ summary: 'Move every pending scheduled call whose day has ended to the next working day' })
  runRollover() {
    return this.rollover.rollOverPending();
  }
}
