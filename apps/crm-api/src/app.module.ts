import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
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
import { ZoomModule } from './modules/zoom/zoom.module.js';
import { AvailabilityModule } from './modules/availability/availability.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    // SEC-008 — global throttle baseline; login has a tighter limit in AuthController
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ScheduleModule.forRoot(),
    MailModule,
    PrismaModule,
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
    ZoomModule,
    AvailabilityModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}


