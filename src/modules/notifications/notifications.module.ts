import { Module } from '@nestjs/common';
import { NotificationsService } from './application/notifications-service.js';
import { ReminderWorker } from './application/reminder-worker.js';
import { NotificationsController } from './infrastructure/controller/notifications.controller.js';
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, ReminderWorker],
})
export class NotificationsModule {}
export { ReminderWorker } from './application/reminder-worker.js';
