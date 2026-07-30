import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CallbacksService } from './callbacks.service';
import { SnoozeCallbackDto } from './dto/callback.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

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
  constructor(private readonly callbacks: CallbacksService) {}

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
}
