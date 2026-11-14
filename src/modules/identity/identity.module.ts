import { Global, Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FeedbackModule } from '../feedback/feedback.module.js';
import { ProfessionalsModule } from '../professionals/professionals.module.js';
import { PublicStoreController } from './infrastructure/controller/public-store.controller.js';
import { IdentityService } from './application/identity-service.js';
import { IdentityController } from './infrastructure/controller/identity.controller.js';
import { GoogleIdentity } from './application/google-identity.js';
import { CustomerHistoryController } from './infrastructure/controller/customer-history.controller.js';
@Global()
@Module({
  imports: [CatalogModule, FeedbackModule, ProfessionalsModule],
  controllers: [IdentityController, PublicStoreController, CustomerHistoryController],
  providers: [IdentityService, GoogleIdentity],
  exports: [IdentityService],
})
export class IdentityModule {}
export { IdentityService } from './application/identity-service.js';
export * from './application/identity.schemas.js';
