import { Module } from '@nestjs/common';
import { ProductivityService } from './productivity.service.js';
import { ProductivityController } from './productivity.controller.js';

@Module({
  controllers: [ProductivityController],
  providers: [ProductivityService],
})
export class ProductivityModule {}
