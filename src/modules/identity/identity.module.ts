import { Global, Module } from '@nestjs/common';
import { IdentityService } from './application/identity-service.js';
import { IdentityController } from './infrastructure/controller/identity.controller.js';
@Global()
@Module({
  controllers: [IdentityController],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
export { IdentityService } from './application/identity-service.js';
export * from './application/identity.schemas.js';
