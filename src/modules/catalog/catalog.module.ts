import { Module } from '@nestjs/common';
import { CatalogService } from './application/catalog-service.js';
import { CatalogController } from './infrastructure/controller/catalog.controller.js';
@Module({
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
export { CatalogService } from './application/catalog-service.js';
export * from './application/catalog.schemas.js';
