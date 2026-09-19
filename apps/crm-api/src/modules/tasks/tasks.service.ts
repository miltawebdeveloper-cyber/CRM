import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateTaskDto, UpdateTaskDto } from './dto/task.dto.js';

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  private async log(leadId: string | null, userId: string, action: string, oldValue: string | null, newValue: string | null) {
    if (!leadId) return;
    await this.prisma.activity.create({ data: { leadId, userId, action, oldValue, newValue } });
  }

  list(ownerId: string) {
    return this.prisma.task.findMany({
      where: { ownerId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async create(dto: CreateTaskDto, ownerId: string, userId: string) {
    const task = await this.prisma.task.create({
      data: {
        title: dto.title,
        priority: dto.priority,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        ownerId,
      },
    });
    await this.log(null, userId, 'task_created', null, task.title);
    return task;
  }

  async update(id: string, dto: UpdateTaskDto, ownerId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.ownerId !== ownerId) throw new ForbiddenException('Not your task');
    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        title: dto.title,
        status: dto.status,
        priority: dto.priority,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
    });
    await this.log(null, userId, 'task_updated', task.title, updated.title);
    return updated;
  }

  async remove(id: string, ownerId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.ownerId !== ownerId) throw new ForbiddenException('Not your task');
    await this.prisma.task.delete({ where: { id } });
    await this.log(null, userId, 'task_deleted', task.title, null);
    return { success: true };
  }
}
