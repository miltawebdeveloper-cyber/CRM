import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';
import { PreferencesService } from './preferences.service.js';
import { SetPreferenceDto } from './dto/preference.dto.js';

@ApiTags('preferences')
@ApiBearerAuth()
@Controller('me/preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  getAll(@CurrentUser() user: AuthUser) {
    return this.preferences.getAll(user.id);
  }

  @Put()
  set(@CurrentUser() user: AuthUser, @Body() dto: SetPreferenceDto) {
    return this.preferences.set(user.id, dto.key, dto.value);
  }

  @Delete(':key')
  remove(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.preferences.remove(user.id, key);
  }
}
