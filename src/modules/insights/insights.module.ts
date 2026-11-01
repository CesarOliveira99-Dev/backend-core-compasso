import { Module } from '@nestjs/common';
import { InsightsService } from './application/insights-service.js';
import { InsightsController } from './infrastructure/controller/insights.controller.js';
@Module({ providers: [InsightsService], controllers: [InsightsController] })
export class InsightsModule {}
