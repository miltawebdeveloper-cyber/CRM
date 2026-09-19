import { Module } from '@nestjs/common';
import { PreferencesService } from './preferences.service.js';
import { PreferencesController } from './preferences.controller.js';

@Module({
  controllers: [PreferencesController],
  providers: [PreferencesService],
  exports: [PreferencesService],
})
export class PreferencesModule {}
