import { Module } from '@nestjs/common';
import { LoyaltyService } from './application/loyalty-service.js';
import { LoyaltyController } from './infrastructure/controller/loyalty.controller.js';
@Module({ providers: [LoyaltyService], controllers: [LoyaltyController] })
export class LoyaltyModule {}
