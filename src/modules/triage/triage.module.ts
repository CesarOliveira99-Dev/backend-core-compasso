import { Module } from '@nestjs/common';
import { TriageService } from './application/triage-service.js';
import { TriageController } from './infrastructure/controller/triage.controller.js';
@Module({ providers: [TriageService], controllers: [TriageController] })
export class TriageModule {}
