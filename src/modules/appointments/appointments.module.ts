import { Module } from '@nestjs/common';
import { AppointmentsService } from './application/appointments-service.js';
import { AppointmentsController } from './infrastructure/controller/appointments.controller.js';
@Module({
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
export { AppointmentsService } from './application/appointments-service.js';
export * from './application/appointments.schemas.js';
