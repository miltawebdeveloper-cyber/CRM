import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CalendarService } from './calendar.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('calendar')
@ApiBearerAuth()
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  /**
   * Scheduled calls, callbacks and Zoom meetings in a date window, plus the counts
   * behind the summary cards.
   *
   * `from`/`to` are plain days from the shared date-range filter; omitting them
   * falls back to the current month. `userId` narrows to one employee and is
   * honoured for managers only — the service ignores it for an employee, who is
   * always scoped to their own schedule.
   */
  @Get('events')
  events(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.calendar.events({ from: from || undefined, to: to || undefined }, user, userId || undefined);
  }
}
