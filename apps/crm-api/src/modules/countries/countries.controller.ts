import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { CountriesService } from './countries.service.js';
import { CreateCountryDto, UpdateCountryDto } from './dto/country.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';

@ApiTags('countries')
@ApiBearerAuth()
@Controller('countries')
export class CountriesController {
  constructor(private readonly countries: CountriesService) {}

  // Active countries for pickers/filters — any authenticated user.
  @Get()
  list() {
    return this.countries.listActive();
  }

  // Full list incl. inactive — admin management screen.
  @Get('all')
  @Roles(Role.admin)
  listAll() {
    return this.countries.listAll();
  }

  @Post()
  @Roles(Role.admin)
  create(@Body() dto: CreateCountryDto) {
    return this.countries.create(dto);
  }

  // No delete route — a country is deactivated (PATCH isActive: false), never
  // removed, since an existing lead may still reference it.
  @Patch(':id')
  @Roles(Role.admin)
  update(@Param('id') id: string, @Body() dto: UpdateCountryDto) {
    return this.countries.update(id, dto);
  }
}
