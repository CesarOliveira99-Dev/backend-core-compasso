import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module.js';
import { CheckoutService } from './application/checkout-service.js';
import { CheckoutController } from './infrastructure/controller/checkout.controller.js';
@Module({
  imports: [AppointmentsModule],
  controllers: [CheckoutController],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
export { CheckoutService } from './application/checkout-service.js';
export * from './application/checkout.schemas.js';
