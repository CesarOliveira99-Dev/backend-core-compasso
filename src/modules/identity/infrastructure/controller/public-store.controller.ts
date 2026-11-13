import { assertPublicWorkspace } from '../../../../core/application/workspace-policy.js';
import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { Context, parse } from '../../../../core/application/context.js';
import type { Actor, Settings } from '../../../../core/domain/models.js';
import { CatalogService } from '../../../catalog/application/catalog-service.js';
import { Public } from '../../application/identity.schemas.js';
import { z } from 'zod';
import { FeedbackService } from '../../../feedback/application/feedback-service.js';
import { ProfessionalsService } from '../../../professionals/professionals.module.js';

@Controller('auth/store')
export class PublicStoreController {
  constructor(
    private readonly context: Context,
    private readonly catalog: CatalogService,
    private readonly feedback: FeedbackService,
    private readonly professionals: ProfessionalsService,
  ) {}

  @Public()
  @Get(':slug')
  get(@Param('slug') value: string) {
    const slug = parse(z.string().min(2).max(60), value);
    const store = this.context.repository.get<{ tenantId: string }>('system', 'stores', slug);
    if (store) assertPublicWorkspace(this.context.repository, store.tenantId);
    const settings =
      store && this.context.repository.get<Settings>(store.tenantId, 'settings', 'business');
    if (!store || !settings) throw new NotFoundException('Estabelecimento não encontrado.');
    // A read-only customer context filters inactive items; no account or membership is created.
    const visitor: Actor = {
      id: '',
      tenantId: store.tenantId,
      role: 'customer',
      name: '',
      email: '',
      phone: '',
    };
    return {
      professionals: this.professionals
        .list(visitor)
        .map(({ id, name, serviceIds }) => ({ id, name, serviceIds })),
      reputation: this.feedback.storeReviews(visitor, {}),
      store: {
        slug: settings.slug,
        businessName: settings.businessName,
        description: settings.description,
        address: settings.address,
        phone: settings.phone,
        media: settings.media,
        weeklyHours: settings.weeklyHours,
        openingHour: settings.openingHour,
        closingHour: settings.closingHour,
        workDays: settings.workDays,
      },
      catalog: this.catalog.list(visitor).map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        kind: item.kind,
        category: item.category,
        media: item.media,
        durationMinutes: item.durationMinutes,
        priceCents: item.priceCents,
        currentPriceCents: item.currentPriceCents,
        percentOff: item.percentOff,
        popularityCount: item.popularityCount,
      })),
    };
  }
}
