import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { CrmThrottlerGuard, crmThrottlers } from './common/guards/crm-throttler.guard.js';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { LeadsModule } from './modules/leads/leads.module.js';
import { MetricsModule } from './modules/metrics/metrics.module.js';
import { TargetsModule } from './modules/targets/targets.module.js';
import { AssignmentsModule } from './modules/assignments/assignments.module.js';
import { CallsModule } from './modules/calls/calls.module.js';
import { ProductivityModule } from './modules/productivity/productivity.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { ActivitiesModule } from './modules/activities/activities.module.js';
import { ConfigStatusModule } from './modules/config/config-status.module.js';
import { TasksModule } from './modules/tasks/tasks.module.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { PreferencesModule } from './modules/preferences/preferences.module.js';
import { OpenPhoneModule } from './modules/openphone/openphone.module.js';
import { IntegrationsModule } from './modules/integrations/integrations.module.js';
import { CommunicationsModule } from './modules/communications/communications.module.js';
import { MailModule } from './modules/mail/mail.module.js';
import { CallbacksModule } from './modules/callbacks/callbacks.module.js';
import { OutcomesModule } from './modules/outcomes/outcomes.module.js';
import { CountriesModule } from './modules/countries/countries.module.js';
import { TimezonesModule } from './modules/timezones/timezones.module.js';
import { ZoomModule } from './modules/zoom/zoom.module.js';
import { AvailabilityModule } from './modules/availability/availability.module.js';
import { HealthController } from './health.controller.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { validateEnv } from './common/env.js';

@Module({
  imports: [
    // `validate` refuses to boot production with missing/placeholder secrets.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'], validate: validateEnv }),
    // SEC-008 — throttling: per user when signed in, per IP + account on sign-in
    // steps, with a per-IP sign-in ceiling. See crmThrottlers / CrmThrottlerGuard.
    ThrottlerModule.forRoot(crmThrottlers()),
    ScheduleModule.forRoot(),
    MailModule,
    PrismaModule,
    JobsModule,
    AuthModule,
    UsersModule,
    LeadsModule,
    MetricsModule,
    TargetsModule,
    AssignmentsModule,
    CallsModule,
    ProductivityModule,
    NotificationsModule,
    AiModule,
    ActivitiesModule,
    ConfigStatusModule,
    TasksModule,
    CalendarModule,
    PreferencesModule,
    OpenPhoneModule,
    IntegrationsModule,
    CommunicationsModule,
    CallbacksModule,
    OutcomesModule,
    CountriesModule,
    TimezonesModule,
    ZoomModule,
    AvailabilityModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: CrmThrottlerGuard }],
})
export class AppModule {}


