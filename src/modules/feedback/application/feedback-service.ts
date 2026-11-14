import {
  recommendationStatus,
  reviewSummary,
  verifiedReviews,
  type RecommendationEntitlement,
} from '../domain/reputation.js';
import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Context, id, parse, timestamp } from '../../../core/application/context.js';
import type { Actor, Appointment, Feedback } from '../../../core/domain/models.js';
@Injectable()
export class FeedbackService {
  constructor(private readonly context: Context) {}
  list(actor: Actor) {
    return this.context.repository
      .list<Feedback>(
        actor.tenantId,
        'feedback',
        actor.role === 'admin' ? {} : { customerId: actor.id },
      )
      .filter((f) => actor.role === 'admin' || f.customerId === actor.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  storeReviews(actor: Actor, query: unknown) {
    const { page } = parse(
      z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }),
      query,
    );
    const appointments = this.context.repository.list<Appointment>(actor.tenantId, 'appointments');
    const reviews = verifiedReviews(
      this.context.repository.list<Feedback>(actor.tenantId, 'feedback'),
      appointments,
    );
    const summary = reviewSummary(reviews);
    const published = reviews
      .filter((review) => review.published === true)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const byId = new Map(appointments.map((appointment) => [appointment.id, appointment]));
    return {
      summary,
      recommendation: recommendationStatus(
        summary,
        this.context.repository.get<RecommendationEntitlement>(
          actor.tenantId,
          'platform_entitlements',
          'recommendation',
        ),
      ),
      reviews: published.slice((page - 1) * 6, page * 6).map((review) => ({
        id: review.id,
        customerName: review.customerName.trim().split(/\s+/)[0] || 'Cliente',
        rating: review.rating,
        comment: review.comment,
        reply: review.reply,
        createdAt: review.createdAt,
        serviceName: byId.get(review.appointmentId)?.itemName || 'Atendimento',
        verified: true,
      })),
      page,
      totalPages: Math.max(1, Math.ceil(published.length / 6)),
      publicCount: published.length,
    };
  }
  create(actor: Actor, body: unknown) {
    const input = parse(
      z.object({
        published: z.boolean().default(false),
        appointmentId: z.string(),
        rating: z.number().int().min(1).max(5),
        comment: z.string().trim().min(3).max(2000),
      }),
      body,
    );
    const appointment = this.context.require<Appointment>(
      actor,
      'appointments',
      input.appointmentId,
    );
    this.context.owned(actor, appointment.customerId);
    if (actor.role !== 'customer' || appointment.status !== 'completed')
      throw new BadRequestException('Avaliações estão disponíveis após o atendimento.');
    if (
      this.context.repository
        .list<Feedback>(actor.tenantId, 'feedback')
        .some((f) => f.appointmentId === appointment.id)
    )
      throw new BadRequestException('Este atendimento já foi avaliado.');
    const feedback: Feedback = {
      ...input,
      id: id(),
      customerId: actor.id,
      customerName: actor.name,
      reply: '',
      createdAt: timestamp(),
    };
    this.context.notifyAdmins(
      actor,
      'Nova avaliação recebida',
      `${actor.name} avaliou com ${input.rating} estrelas.`,
    );
    return this.context.repository.put(actor.tenantId, 'feedback', feedback.id, feedback);
  }
  reply(actor: Actor, recordId: string, body: unknown) {
    this.context.admin(actor);
    const input = parse(z.object({ reply: z.string().trim().min(3).max(2000) }), body);
    const feedback = this.context.require<Feedback>(actor, 'feedback', recordId);
    this.context.notify(actor, feedback.customerId, 'Resposta à sua avaliação', input.reply);
    return this.context.repository.put(actor.tenantId, 'feedback', recordId, {
      ...feedback,
      ...input,
    });
  }
}
