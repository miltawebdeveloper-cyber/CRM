import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { OutcomesService } from './outcomes.service.js';
import { CreateOutcomeDto, UpdateOutcomeDto } from './dto/outcome.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';

@ApiTags('outcomes')
@ApiBearerAuth()
@Controller('outcomes')
export class OutcomesController {
  constructor(private readonly outcomes: OutcomesService) {}

  // Active outcomes for pickers/filters — any authenticated user.
  @Get()
  list() {
    return this.outcomes.listActive();
  }

  // Full list incl. inactive — admin management screen.
  @Get('all')
  @Roles(Role.admin)
  listAll() {
    return this.outcomes.listAll();
  }

  @Post()
  @Roles(Role.admin)
  create(@Body() dto: CreateOutcomeDto) {
    return this.outcomes.create(dto);
  }

  @Patch(':id')
  @Roles(Role.admin)
  update(@Param('id') id: string, @Body() dto: UpdateOutcomeDto) {
    return this.outcomes.update(id, dto);
  }

  @Delete(':id')
  @Roles(Role.admin)
  remove(@Param('id') id: string) {
    return this.outcomes.remove(id);
  }
}
