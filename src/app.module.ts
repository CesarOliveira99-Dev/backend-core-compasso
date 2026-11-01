import { Global, Module } from '@nestjs/common';
import { Context } from './core/application/context.js';
import { DocumentRepository, REPOSITORY } from './core/infrastructure/document.repository.js';
import { AppointmentsModule } from './modules/appointments/appointments.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { CheckoutModule } from './modules/checkout/checkout.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { FeedbackModule } from './modules/feedback/feedback.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { InsightsModule } from './modules/insights/insights.module.js';
import { LoyaltyModule } from './modules/loyalty/loyalty.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { PromotionsModule } from './modules/promotions/promotions.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { TriageModule } from './modules/triage/triage.module.js';
@Global()
@Module({
  providers: [{ provide: REPOSITORY, useClass: DocumentRepository }, Context],
  exports: [REPOSITORY, Context],
})
class CoreModule {}
@Module({
  imports: [
    CoreModule,
    IdentityModule,
    CatalogModule,
    CustomersModule,
    AppointmentsModule,
    CheckoutModule,
    PromotionsModule,
    TriageModule,
    FeedbackModule,
    LoyaltyModule,
    NotificationsModule,
    SettingsModule,
    InsightsModule,
  ],
})
export class AppModule {}
