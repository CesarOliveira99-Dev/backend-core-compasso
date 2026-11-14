import { isSolo } from '../../core/application/workspace-policy.js';
import { PaymentProviderRejected } from './payment-provider-error.js';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Context, parse, timestamp } from '../../core/application/context.js';
import { employeeSeats, planPrice, findPlan, STORE_PLANS, SOLO_PLANS, storeEntitlement, type PlanId, type StoreSubscription } from '../../core/application/store-plans.js';
import { emailQuota } from '../../core/application/email-quota.js';
import type { Actor } from '../../core/domain/models.js';

type Call = <T>(path: string, token?: string, body?: unknown, key?: string, method?: 'PUT') => Promise<T>;
interface Reference { tenantId: string; planId: PlanId; priceCents: number; extraEmployees?: number; priceHistory?: number[]; periodMonths?: number }
interface ExtraChange { subscriptionId: string; extraEmployees: number; priceCents: number; createdAt: string }
interface Setup extends Reference { key: string; reference: string; createdAt: number }
const scope = '__compasso_payments__';
const referencePrefix = 'compasso-sub:';
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const preapprovalSchema = z.object({
  id: identifier, collector_id: z.union([z.number(), z.string()]),
  external_reference: z.string(), status: z.enum(['pending', 'authorized', 'paused', 'cancelled', 'canceled']),
  init_point: z.url(), auto_recurring: z.object({ transaction_amount: z.number().positive(), currency_id: z.literal('BRL'),
    frequency: z.union([z.literal(1), z.literal(12)]), frequency_type: z.literal('months') }),
});
const numberId = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]);
const invoiceSchema = z.object({ id: numberId, preapproval_id: identifier, currency_id: z.string(),
  transaction_amount: z.union([z.string(), z.number()]), debit_date: z.string(),
  payment: z.object({ id: numberId.optional() }).nullable().optional(),
});
const chargeSchema = z.object({ id: numberId, collector_id: numberId, currency_id: z.string(),
  transaction_amount: z.number().positive(), transaction_amount_refunded: z.number().nonnegative().optional(),
  live_mode: z.boolean(), status: z.string(), date_approved: z.string().nullable().optional() });

/** Add billing calendar months without overflowing February or short months. */
export function subscriptionPeriodEnd(start: number, months = 1) {
  const date = new Date(start), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}

export class SubscriptionBilling {
  private readonly creating = new Set<string>();
  constructor(private readonly context: Context, private readonly call: Call) {}
  private get repo() { return this.context.repository; }
  enabled() { return process.env.COMPASSO_SUBSCRIPTIONS_ENABLED === 'true' && !!(
    process.env.MP_PLATFORM_ACCESS_TOKEN && process.env.MP_PLATFORM_USER_ID && process.env.MP_WEBHOOK_SECRET &&
    process.env.APP_URL && process.env.PUBLIC_API_URL); }
  status(actor: Actor) {
    this.context.admin(actor);
    const access = storeEntitlement(this.repo, actor.tenantId);
    const subscription = this.repo.get<StoreSubscription>(actor.tenantId, 'billing', 'subscription');
    return { billingEnabled: this.enabled(), plans: isSolo(this.repo, actor.tenantId) ? SOLO_PLANS : STORE_PLANS, entitlement: access,
      emailUsage: emailQuota(this.repo, actor.tenantId), employeesUsed: employeeSeats(this.repo, actor.tenantId),
      extrasPending: !!this.repo.get(actor.tenantId, 'billing', 'extras_change'),
      setupPending: !!this.repo.get(actor.tenantId, 'billing', 'subscription_setup'),
      subscription: subscription ? { id: subscription.id, planId: subscription.planId, priceCents: subscription.priceCents,
        extraEmployees: subscription.extraEmployees || 0, status: subscription.status, paidThrough: subscription.paidThrough, checkedAt: subscription.checkedAt } : null };
  }
  async subscribe(actor: Actor, body: unknown) {
    this.context.admin(actor);
    const { planId, extraEmployees } = parse(z.object({ planId: z.enum(['essencial', 'profissional', 'equipe', 'solo-mensal', 'solo-anual']), extraEmployees: z.number().int().min(0).max(90).default(0) }).strict(), body);
    const solo = isSolo(this.repo, actor.tenantId);
    if (solo !== planId.startsWith('solo-')) throw new ForbiddenException('Plano incompatível com a modalidade da conta.');
    const priceCents = planPrice(planId, extraEmployees);
    if (!this.enabled()) throw new ServiceUnavailableException('A contratação dos planos ainda não foi ativada.');
    if (storeEntitlement(this.repo, actor.tenantId).mode === 'trial')
      throw new ConflictException('A contratação ficará disponível ao terminar o teste grátis. Nenhuma cobrança será iniciada durante o teste.');
    const plan = findPlan(planId)!;
    const periodMonths = 'periodMonths' in plan ? plan.periodMonths : 1;
    if (employeeSeats(this.repo, actor.tenantId) > plan.employees + extraEmployees)
      throw new BadRequestException(`Desative os funcionários excedentes antes de contratar este plano de até ${plan.employees} funcionário(s).`);
    const existing = this.repo.get<StoreSubscription>(actor.tenantId, 'billing', 'subscription');
    if (existing && existing.status !== 'cancelled' && existing.status !== 'canceled') {
      if (existing.planId !== planId || (existing.extraEmployees || 0) !== extraEmployees) throw new ConflictException('Gerencie ou cancele a assinatura atual antes de mudar de plano.');
      return { url: existing.url };
    }
    if ((existing?.paidThrough || 0) > Date.now())
      throw new ConflictException('Seu período pago ainda está válido. Aguarde o término para contratar outro plano sem sobrepor cobranças.');
    if (this.creating.has(actor.tenantId)) throw new ConflictException('Sua assinatura está sendo preparada. Aguarde.');
    this.creating.add(actor.tenantId);
    try {
      const pending = this.repo.get<Setup>(actor.tenantId, 'billing', 'subscription_setup');
      if (pending) {
        await this.refresh(actor);
        const recovered = this.repo.get<StoreSubscription>(actor.tenantId, 'billing', 'subscription');
        if (recovered && recovered.externalReference === pending.reference && recovered.planId === planId && (recovered.extraEmployees || 0) === extraEmployees) return { url: recovered.url };
        throw new ConflictException('A tentativa anterior aguarda conferência. Atualize a situação antes de contratar novamente.');
      }
      const app = new URL(process.env.APP_URL!), api = new URL(process.env.PUBLIC_API_URL!);
      if (app.protocol !== 'https:' || api.protocol !== 'https:') throw new BadRequestException('Assinaturas exigem URLs HTTPS.');
      const key = randomUUID();
      const setup: Setup = { tenantId: actor.tenantId, planId, priceCents, extraEmployees, periodMonths, key,
        reference: `${referencePrefix}${actor.tenantId}:${key}`, createdAt: Date.now() };
      this.repo.transaction(() => {
        this.repo.put(actor.tenantId, 'billing', 'subscription_setup', setup);
        this.repo.put(scope, 'billing_references', setup.reference, setup);
      });
      // Never recreate a pending setup after a transport failure. Recover by reference instead.
      const result = await this.call<unknown>('/preapproval', this.token(), {
        reason: `Compasso ${plan.name} — assinatura ${periodMonths === 12 ? 'anual' : 'mensal'}`, external_reference: setup.reference,
        payer_email: actor.email, back_url: app.toString(),
        auto_recurring: { frequency: periodMonths, frequency_type: 'months', transaction_amount: priceCents / 100, currency_id: 'BRL' },
        status: 'pending',
      }, key);
      const record = this.savePreapproval(result, setup.reference);
      return { url: record.url };
    } finally { this.creating.delete(actor.tenantId); }
  }
  async changeExtras(actor: Actor, body: unknown) {
    this.context.admin(actor);
    const input = parse(z.object({ extraEmployees: z.number().int().min(0).max(90), expectedPriceCents: z.number().int().positive() }).strict(), body);
    const priceCents = planPrice('equipe', input.extraEmployees);
    if (input.expectedPriceCents !== priceCents) throw new ConflictException('O valor mudou. Confira a mensalidade antes de confirmar.');
    if (!this.enabled()) throw new ServiceUnavailableException('A contratação dos planos ainda não foi ativada.');
    if (this.creating.has(actor.tenantId)) throw new ConflictException('Aguarde a alteração em andamento.');
    this.creating.add(actor.tenantId);
    try {
      const current = this.repo.get<StoreSubscription>(actor.tenantId, 'billing', 'subscription');
      if (!current || current.planId !== 'equipe' || current.status !== 'authorized' || storeEntitlement(this.repo, actor.tenantId).mode !== 'active')
        throw new ForbiddenException('Colaboradores extras exigem uma assinatura Equipe autorizada e com período pago vigente.');
      if (employeeSeats(this.repo, actor.tenantId) > 10 + input.extraEmployees)
        throw new ConflictException('Desative os colaboradores excedentes antes de reduzir as vagas extras.');
      const pending = this.repo.get<ExtraChange>(actor.tenantId, 'billing', 'extras_change');
      if (pending) {
        await this.preapproval(current.id);
        if (this.repo.get(actor.tenantId, 'billing', 'extras_change'))
          throw new ConflictException('A alteração anterior aguarda conferência no Mercado Pago. Atualize a situação; não foi enviada outra alteração.');
        const recovered = this.repo.get<StoreSubscription>(actor.tenantId, 'billing', 'subscription')!;
        if ((recovered.extraEmployees || 0) !== input.extraEmployees) throw new ConflictException('A alteração anterior foi confirmada. Confira o valor atual antes de continuar.');
        return this.status(actor);
      }
      if ((current.extraEmployees || 0) === input.extraEmployees) return this.status(actor);
      const intent: ExtraChange = { subscriptionId: current.id, extraEmployees: input.extraEmployees, priceCents, createdAt: timestamp() };
      this.repo.put(actor.tenantId, 'billing', 'extras_change', intent);
      try {
        const result = await this.call<unknown>('/preapproval/' + encodeURIComponent(current.id), this.token(), {
          auto_recurring: { transaction_amount: priceCents / 100, currency_id: 'BRL' },
        }, undefined, 'PUT');
        const record = this.savePreapproval(result, current.externalReference);
        if (record.priceCents !== priceCents || this.repo.get(actor.tenantId, 'billing', 'extras_change'))
          throw new ConflictException('A alteração aguarda confirmação. Atualize a situação antes de adicionar colaboradores.');
      } catch (error) {
        if (error instanceof PaymentProviderRejected) this.repo.remove(actor.tenantId, 'billing', 'extras_change');
        throw error;
      }
      return this.status(actor);
    } finally { this.creating.delete(actor.tenantId); }
  }
  private token() {
    if (!process.env.MP_PLATFORM_ACCESS_TOKEN || !process.env.MP_PLATFORM_USER_ID)
      throw new ServiceUnavailableException('Recebimento das assinaturas ainda não configurado.');
    return process.env.MP_PLATFORM_ACCESS_TOKEN;
  }
  private savePreapproval(raw: unknown, expectedReference?: string) {
    const parsed = preapprovalSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('Resposta de assinatura inválida.');
    const result = parsed.data;
    if (expectedReference && result.external_reference !== expectedReference)
      throw new ForbiddenException('Referência da assinatura incompatível.');
    const reference = this.repo.get<Reference>(scope, 'billing_references', result.external_reference);
    const pending = reference && this.repo.get<ExtraChange>(reference.tenantId, 'billing', 'extras_change');
    const actualPrice = Math.round(result.auto_recurring.transaction_amount * 100);
    const changed = pending && pending.subscriptionId === result.id && pending.priceCents === actualPrice;
    if (!reference || String(result.collector_id) !== process.env.MP_PLATFORM_USER_ID ||
        (actualPrice !== reference.priceCents && !changed) ||
        result.auto_recurring.frequency !== (reference?.periodMonths || 1))
      throw new ForbiddenException('Assinatura, recebedor ou valor incompatível.');
    const url = new URL(result.init_point);
    if (url.protocol !== 'https:' || !/(^|\.)mercadopago\.com(\.br)?$/.test(url.hostname))
      throw new ForbiddenException('Endereço da assinatura inválido.');
    return this.repo.transaction(() => {
      const previous = this.repo.get<StoreSubscription>(reference.tenantId, 'billing', 'subscription');
      if (previous && previous.id !== result.id && previous.externalReference === result.external_reference)
        throw new ConflictException('Esta contratação já tem outra assinatura.');
      if (previous && previous.externalReference !== result.external_reference &&
          (previous.status !== 'cancelled' || (previous.paidThrough || 0) > Date.now()))
        throw new ConflictException('A loja possui outra assinatura vigente.');
      const terms: Reference = changed ? { ...reference, priceCents: pending.priceCents, extraEmployees: pending.extraEmployees,
        priceHistory: [...new Set([...(reference.priceHistory || []), reference.priceCents])] } : reference;
      const record: StoreSubscription = { id: result.id, planId: terms.planId, priceCents: terms.priceCents, periodMonths: terms.periodMonths || 1, extraEmployees: terms.extraEmployees || 0,
        url: result.init_point, status: result.status === 'canceled' ? 'cancelled' : result.status,
        externalReference: result.external_reference, checkedAt: timestamp(),
        ...(previous?.id === result.id ? { paidThrough: previous.paidThrough } : {}) };
      this.repo.put(reference.tenantId, 'billing', 'subscription', record);
      this.repo.put(scope, 'billing_subscriptions', result.id, { ...terms, externalReference: result.external_reference });
      this.repo.put(scope, 'billing_references', result.external_reference, terms);
      if (changed) this.repo.remove(reference.tenantId, 'billing', 'extras_change');
      const setup = this.repo.get<Setup>(reference.tenantId, 'billing', 'subscription_setup');
      if (setup?.reference === result.external_reference) this.repo.remove(reference.tenantId, 'billing', 'subscription_setup');
      return record;
    });
  }
  async preapproval(id: string) {
    parse(identifier, id);
    const raw = await this.call<{ id: string }>('/preapproval/' + encodeURIComponent(id), this.token());
    if (raw.id !== id) throw new ForbiddenException('Assinatura incompatível.');
    return this.savePreapproval(raw);
  }
  async cancelPending(actor: Actor) {
    this.context.admin(actor);
    if (this.creating.has(actor.tenantId)) throw new ConflictException('Aguarde a operação anterior terminar.');
    this.creating.add(actor.tenantId);
    try {
      const current = this.repo.get<StoreSubscription>(actor.tenantId, 'billing', 'subscription');
      if (!current || current.status !== 'pending' || (current.paidThrough || 0) > Date.now())
        throw new ConflictException('Somente uma contratação pendente e sem período pago pode ser cancelada aqui.');
      if (this.repo.list<{ subscriptionId: string }>(actor.tenantId, 'subscription_invoices').some(invoice => invoice.subscriptionId === current.id))
        throw new ConflictException('Há uma fatura vinculada. Atualize a situação antes de cancelar.');
      const checked = await this.preapproval(current.id);
      if (checked.status === 'cancelled') return this.status(actor);
      if (checked.status !== 'pending') throw new ConflictException('A assinatura mudou no Mercado Pago. Atualize a situação antes de cancelar.');
      await this.call('/preapproval/' + encodeURIComponent(current.id), this.token(), { status: 'canceled' }, undefined, 'PUT');
      const cancelled = await this.preapproval(current.id);
      if (cancelled.status !== 'cancelled') throw new ConflictException('O cancelamento ainda não foi confirmado no Mercado Pago. Atualize a situação.');
      return this.status(actor);
    } finally { this.creating.delete(actor.tenantId); }
  }
  async refresh(actor: Actor) {
    this.context.admin(actor);
    let subscription = this.repo.get<StoreSubscription>(actor.tenantId, 'billing', 'subscription');
    const setup = this.repo.get<Setup>(actor.tenantId, 'billing', 'subscription_setup');
    if (setup && (!subscription || subscription.externalReference !== setup.reference)) {
      const response = await this.call<{ results: unknown[] }>(`/preapproval/search?external_reference=${encodeURIComponent(setup.reference)}`, this.token());
      if (!Array.isArray(response.results) || response.results.length !== 1)
        throw new ConflictException('A contratação ainda aguarda conferência no Mercado Pago. Nenhuma nova cobrança foi criada.');
      subscription = this.savePreapproval(response.results[0], setup.reference);
    }
    if (!subscription) throw new BadRequestException('Você ainda não iniciou uma assinatura.');
    await this.preapproval(subscription.id);
    // Reconcile every page, bounded to avoid a single refresh exhausting provider throughput.
    for (let offset = 0; offset < 100; offset += 20) {
      const response = await this.call<{ results: { id: string | number }[]; paging?: { total: number } }>(
        `/authorized_payments/search?preapproval_id=${encodeURIComponent(subscription.id)}&limit=20&offset=${offset}`, this.token());
      if (!Array.isArray(response.results)) throw new BadRequestException('Resposta de faturas inválida.');
      for (const invoice of response.results) await this.invoice(String(invoice.id));
      if (response.results.length < 20 || offset + 20 >= (response.paging?.total || 0)) break;
    }
    return this.status(actor);
  }
  async invoice(id: string, expectedPaymentId?: string) {
    parse(numberId, id);
    const invoice = parse(invoiceSchema, await this.call<unknown>(`/authorized_payments/${encodeURIComponent(id)}`, this.token()));
    if (String(invoice.id) !== id) throw new ForbiddenException();
    if (expectedPaymentId && String(invoice.payment?.id) !== expectedPaymentId) return false;
    let owner = this.repo.get<Reference>(scope, 'billing_subscriptions', invoice.preapproval_id);
    if (!owner) {
      try { await this.preapproval(invoice.preapproval_id); }
      catch (error) { if (error instanceof ForbiddenException) return false; throw error; }
      owner = this.repo.get<Reference>(scope, 'billing_subscriptions', invoice.preapproval_id);
    }
    if (!owner) return false;
    const invoicePrice = Math.round(Number(invoice.transaction_amount) * 100);
    if (![owner.priceCents, ...(owner.priceHistory || [])].includes(invoicePrice) &&
        this.repo.get(owner.tenantId, 'billing', 'extras_change')) {
      await this.preapproval(invoice.preapproval_id);
      owner = this.repo.get<Reference>(scope, 'billing_subscriptions', invoice.preapproval_id)!;
    }
    if (invoice.currency_id !== 'BRL' || ![owner.priceCents, ...(owner.priceHistory || [])].includes(invoicePrice))
      throw new ForbiddenException('Valor da fatura incompatível.');
    if (!invoice.payment?.id) return true;
    const charge = parse(chargeSchema, await this.call<unknown>(`/v1/payments/${invoice.payment.id}`, this.token()));
    if (String(charge.id) !== String(invoice.payment.id) || String(charge.collector_id) !== process.env.MP_PLATFORM_USER_ID ||
      charge.currency_id !== 'BRL' || Math.round(charge.transaction_amount * 100) !== invoicePrice ||
      charge.live_mode !== (process.env.MP_SANDBOX !== 'true')) throw new ForbiddenException('Pagamento da assinatura incompatível.');
    const approved = charge.status === 'approved' && !(charge.transaction_amount_refunded || 0);
    const approval = Date.parse(charge.date_approved || '');
    const debit = Date.parse(invoice.debit_date);
    if (approved && (!Number.isFinite(approval) || !Number.isFinite(debit) || approval > Date.now() + 60000 || debit > Date.now() + 86400000))
      throw new BadRequestException('Data de cobrança inválida.');
    this.repo.transaction(() => {
      const previous = this.repo.get<{ paymentId: string; approved: boolean }>(owner!.tenantId, 'subscription_invoices', id);
      if (previous?.approved && previous.paymentId !== String(charge.id)) throw new ConflictException('Fatura já possui outro pagamento.');
      this.repo.put(owner!.tenantId, 'subscription_invoices', id, { id, subscriptionId: invoice.preapproval_id,
        paymentId: String(charge.id), approved, endsAt: approved ? subscriptionPeriodEnd(debit, owner!.periodMonths || 1) : 0 });
      this.repo.put(scope, 'billing_payment_invoices', String(charge.id), { invoiceId: id });
      this.recompute(owner!.tenantId, invoice.preapproval_id);
    });
    return true;
  }
  private recompute(tenantId: string, subscriptionId: string) {
    const current = this.repo.get<StoreSubscription>(tenantId, 'billing', 'subscription');
    if (!current || current.id !== subscriptionId) return;
    const records = this.repo.list<{ subscriptionId: string; approved: boolean; endsAt: number }>(tenantId, 'subscription_invoices');
    const paidThrough = Math.max(0, ...records.filter(invoice => invoice.subscriptionId === subscriptionId && invoice.approved).map(invoice => invoice.endsAt));
    this.repo.put(tenantId, 'billing', 'subscription', { ...current, paidThrough });
  }
  async payment(id: string) {
    const known = this.repo.get<{ invoiceId: string }>(scope, 'billing_payment_invoices', id);
    if (known) return this.invoice(known.invoiceId, id);
    const result = await this.call<{ results: { id: number | string }[] }>(`/authorized_payments/search?payment_id=${encodeURIComponent(id)}&limit=20`, this.token());
    if (!Array.isArray(result.results)) throw new BadRequestException('Resposta de faturas inválida.');
    let handled = false;
    for (const item of result.results) handled = await this.invoice(String(item.id), id) || handled;
    return handled;
  }
}
