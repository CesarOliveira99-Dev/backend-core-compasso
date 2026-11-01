import { Module } from '@nestjs/common';
import { SettingsService } from './application/settings-service.js';
import { SettingsController } from './infrastructure/controller/settings.controller.js';
@Module({ providers: [SettingsService], controllers: [SettingsController] })
export class SettingsModule {}
export * from './application/settings.schemas.js';
