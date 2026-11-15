import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Context, parse } from '../../../core/application/context.js';
import type { Actor, Appointment, CatalogItem, Customer, Feedback, Settings } from '../../../core/domain/models.js';
import { FeedbackService } from '../../feedback/application/feedback-service.js';

/** History follows proven identity membership, never an e-mail supplied by a caller. */
export class CustomerHistory {
  constructor(private readonly context: Context) {}
  private visits(actor: Actor) {
    if (actor.role !== 'customer') throw new ForbiddenException('Área exclusiva do cliente.');
    const repo = this.context.repository;
    const identityId = actor.identityId || actor.id;
    return repo.list<{ tenantId: string }>('system', 'stores').flatMap((store) => {
      const settings = repo.get<Settings>(store.tenantId, 'settings', 'business');
      if (!settings || settings.workspaceMode === 'solo') return [];
      const members = repo.list<Customer>(store.tenantId, 'customers', { identityId });
      const current = store.tenantId === actor.tenantId
        ? repo.get<Customer>(store.tenantId, 'customers', actor.id) : undefined;
      if (current && !members.some((member) => member.id === current.id)) members.push(current);
      return members.filter((member) => member.role === 'customer' && !member.internal && member.active !== false &&
        (member.identityId || member.id) === identityId).flatMap((member) =>
        repo.list<Appointment>(store.tenantId, 'appointments', { customerId: member.id })
          .filter((appointment) => appointment.customerId === member.id && appointment.status === 'completed')
          .map((appointment) => ({
            member, settings, appointment,
            key: createHash('sha256').update(`${store.tenantId}:${appointment.id}`).digest('hex'),
          })),
      );
    }).sort((a, b) =>
      Date.parse(b.appointment.completedAt || b.appointment.endsAt) -
      Date.parse(a.appointment.completedAt || a.appointment.endsAt) || b.key.localeCompare(a.key),
    );
  }
  latest(actor: Actor) {
    const visit = this.visits(actor)[0];
    if (!visit) return null;
    const { appointment, member, settings, key } = visit;
    const repo = this.context.repository;
    const service = repo.get<CatalogItem>(member.tenantId, 'catalog', appointment.itemId);
    const review = repo.list<Feedback>(member.tenantId, 'feedback', { customerId: member.id })
      .find((item) => item.customerId === member.id && item.appointmentId === appointment.id);
    return {
      key, appointmentId: appointment.id,
      service: { id: appointment.itemId, name: appointment.itemName,
        image: service?.media?.find((asset) => asset.type === 'image')?.url,
        available: !!service?.active && service.kind === 'service' },
      store: { slug: settings.slug, name: settings.businessName,
        image: settings.media?.find((asset) => asset.type === 'image' && asset.category !== 'portfolio')?.url },
      professionalName: appointment.professionalName || 'Equipe do estabelecimento',
      startsAt: appointment.startsAt, timezone: settings.timezone,
      review: review ? { rating: review.rating } : null,
    };
  }
  review(actor: Actor, body: unknown) {
    const input = parse(z.object({
      key: z.string().regex(/^[a-f0-9]{64}$/),
      rating: z.number().int().min(1).max(5),
      comment: z.string().trim().min(3).max(2000),
      published: z.boolean().default(false),
    }), body);
    return this.context.repository.transaction(() => {
      const visit = this.visits(actor).find((entry) => entry.key === input.key);
      if (!visit) throw new NotFoundException('Atendimento não encontrado.');
      const { passwordHash: _, addresses: __, ...member } = visit.member;
      return new FeedbackService(this.context).create(member, {
        appointmentId: visit.appointment.id, rating: input.rating,
        comment: input.comment, published: input.published,
      });
    });
  }
}
