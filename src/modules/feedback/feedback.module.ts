import { Module } from '@nestjs/common';
import { FeedbackService } from './application/feedback-service.js';
import { FeedbackController } from './infrastructure/controller/feedback.controller.js';
@Module({ providers: [FeedbackService], controllers: [FeedbackController] })
export class FeedbackModule {}
