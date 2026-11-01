import { Module } from '@nestjs/common';
import { PromotionsService } from './application/promotions-service.js';
import { PromotionsController } from './infrastructure/controller/promotions.controller.js';
@Module({ providers: [PromotionsService], controllers: [PromotionsController] })
export class PromotionsModule {}
export * from './application/promotions.schemas.js';
