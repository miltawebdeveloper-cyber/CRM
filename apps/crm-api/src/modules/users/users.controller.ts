import { Body, Controller, Get, Param, Patch, Post, Query, Delete, HttpCode } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto, ListUsersQueryDto } from './dto/user.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

// User management is Admin-only (Permission Matrix: Create/Edit/Deactivate users).
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // View All Users — Admin + Team Leader (Permission Matrix)
  @Roles(Role.admin, Role.team_leader)
  @Get()
  findAll(@Query() query: ListUsersQueryDto) {
    return this.users.findAll(query);
  }

  @Roles(Role.admin, Role.team_leader)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
  }

  @Roles(Role.admin)
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Roles(Role.admin)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Roles(Role.admin)
  @Delete(':id')
  @HttpCode(200)
  deactivate(@Param('id') id: string) {
    return this.users.deactivate(id);
  }

  /**
   * Permanently remove an account (admin only).
   *
   * A separate route rather than a flag on the one above, because these are two
   * different decisions and the safe one must stay the default: `DELETE /users/:id`
   * has always meant "deactivate" and every existing caller relies on that. This
   * is the irreversible one, and it says so in the path.
   *
   * Refuses with 409 for a user who has recorded work — see `UsersService.remove`.
   */
  @Roles(Role.admin)
  @Delete(':id/permanent')
  @HttpCode(200)
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.users.remove(id, { id: user.id });
  }
}
