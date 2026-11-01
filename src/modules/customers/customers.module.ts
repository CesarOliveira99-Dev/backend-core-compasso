import { Module } from '@nestjs/common';
import { CustomersService } from './application/customers-service.js';
import { CustomersController } from './infrastructure/controller/customers.controller.js';
@Module({ providers: [CustomersService], controllers: [CustomersController] })
export class CustomersModule {}
export * from './application/customers.schemas.js';
