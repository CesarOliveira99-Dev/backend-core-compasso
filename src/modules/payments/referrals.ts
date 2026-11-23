import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Context, parse } from '../../core/application/context.js';
import type { Actor, Customer, Settings } from '../../core/domain/models.js';
import type { Trial } from '../../core/application/store-plans.js';

export const REFERRAL_SCOPE = '__compasso_referrals__';
export const referralCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{12}$/, 'Código de indicação inválido.');
interface Code { code: string; tenantId: string; identityId: string; emailHash: string }
export interface Referral {
  tenantId: string; identityId: string; referrerTenantId: string; createdAt: number;
  eligible: boolean;
}
interface Invoice { approved: boolean; approvedAt?: number; paidAmountCents?: number; endsAt: number }
export interface DiscountCycle {
  id: string; subscriptionId: string; dueAt: number; discountBps: number;
  baseCents: number; amountCents: number; state: 'preparing' | 'applied' | 'consumed' | 'released';
  invoiceId?: string; approved?: boolean;
}
function emailHash(email: string) { return createHash('sha256').update(email.trim().toLowerCase()).digest('hex'); }
export function discountAmount(baseCents: number, totalCents: number, bps: number) {
  if (![baseCents, totalCents, bps].every(Number.isSafeInteger) || baseCents < 1 || totalCents < baseCents || bps < 0 || bps > 10000)
    throw new BadRequestException('Desconto inválido.');
  return totalCents - Math.round(baseCents * bps / 10000);
}
export class Referrals {
  constructor(private readonly context: Context) {}
  private get repo() { return this.context.repository; }
  enabled() { return process.env.COMPASSO_REFERRALS_ENABLED === 'true'; }
  assertEnabled() { if (!this.enabled()) throw new ServiceUnavailableException('Indicações ainda não estão disponíveis.'); }
  private owner(tenantId: string) {
    const settings = this.repo.get<Settings>(tenantId, 'settings', 'business');
    return settings?.ownerId ? this.repo.get<Customer>(tenantId, 'customers', settings.ownerId) : undefined;
  }
  status(actor: Actor) {
    this.assertEnabled(); this.context.admin(actor);
    const code = this.repo.transaction(() => {
      const existing = this.repo.get<Code>(actor.tenantId, 'billing', 'referral_code');
      if (existing) return existing.code;
      let value: string;
      do { value = randomBytes(6).toString('hex').toUpperCase(); } while (this.repo.get(REFERRAL_SCOPE, 'codes', value));
      const record = { code: value, tenantId: actor.tenantId, identityId: actor.identityId || actor.id, emailHash: emailHash(actor.email) };
      this.repo.put(REFERRAL_SCOPE, 'codes', value, record);
      this.repo.put(actor.tenantId, 'billing', 'referral_code', record);
      return value;
    });
    const referrals = this.repo.list<Referral>(REFERRAL_SCOPE, 'attributions').filter(row => row.referrerTenantId === actor.tenantId);
    const balanceBps = this.balance(actor.tenantId);
    const upcoming = this.repo.list<DiscountCycle>(actor.tenantId, 'referral_cycles').find(cycle => cycle.state === 'applied' || cycle.state === 'preparing');
    return { code, balancePercent: Math.max(0, balanceBps) / 100, pending: referrals.filter(row => !row.eligible).length,
      qualified: referrals.filter(row => row.eligible).length, nextDiscountPercent: upcoming ? upcoming.discountBps / 100 : Math.min(100, Math.max(0, balanceBps) / 100) };
  }
  // Called inside account creation's existing transaction. An identity can be referred once, across all spaces.
  attribute(actor: Actor, rawCode: unknown, existingOwner = false) {
    if (!rawCode) return;
    this.assertEnabled();
    const code = parse(referralCodeSchema, rawCode);
    const reference = this.repo.get<Code>(REFERRAL_SCOPE, 'codes', code);
    const issuer = reference && this.owner(reference.tenantId);
    if (!reference || !issuer || issuer.active === false)
      throw new BadRequestException('Código de indicação indisponível.');
    const identityId = actor.identityId || actor.id;
    const hash = emailHash(actor.email);
    if (actor.role !== 'admin' || existingOwner || reference.tenantId === actor.tenantId || reference.identityId === identityId || reference.emailHash === hash)
      throw new BadRequestException('Esta conta não pode usar este código de indicação.');
    if (this.repo.get(REFERRAL_SCOPE, 'identities', identityId) || this.repo.get(REFERRAL_SCOPE, 'emails', hash))
      throw new BadRequestException('Esta pessoa já possui uma indicação.');
    const record: Referral = { tenantId: actor.tenantId, identityId, referrerTenantId: reference.tenantId, createdAt: Date.now(), eligible: false };
    this.repo.put(REFERRAL_SCOPE, 'attributions', actor.tenantId, record);
    this.repo.put(REFERRAL_SCOPE, 'identities', identityId, { tenantId: actor.tenantId });
    this.repo.put(REFERRAL_SCOPE, 'emails', hash, { tenantId: actor.tenantId });
  }
  reconcile(tenantId: string, now = Date.now()) {
    return this.repo.transaction(() => {
      const row = this.repo.get<Referral>(REFERRAL_SCOPE, 'attributions', tenantId);
      if (!row) return;
      const trial = this.repo.get<Trial>(tenantId, 'billing', 'trial');
      const eligible = !!trial && now >= trial.endsAt && this.repo.list<Invoice>(tenantId, 'subscription_invoices')
        .some(invoice => invoice.approved && (invoice.paidAmountCents || 0) > 0 && Number.isFinite(invoice.approvedAt) && invoice.approvedAt! >= row.createdAt && invoice.endsAt > trial.endsAt);
      this.repo.put(REFERRAL_SCOPE, 'attributions', tenantId, { ...row, eligible });
      return row.referrerTenantId;
    });
  }
  balance(tenantId: string) {
    const earned = this.repo.list<Referral>(REFERRAL_SCOPE, 'attributions').filter(row => row.referrerTenantId === tenantId && row.eligible).length * 1500;
    const reserved = this.repo.list<DiscountCycle>(tenantId, 'referral_cycles').filter(cycle => cycle.state !== 'released').reduce((sum, cycle) => sum + cycle.discountBps, 0);
    return earned - reserved;
  }
  issuerTenants() { return [...new Set(this.repo.list<Referral>(REFERRAL_SCOPE, 'attributions').map(row => row.referrerTenantId))]; }
  referredTenants() { return this.repo.list<Referral>(REFERRAL_SCOPE, 'attributions').map(row => row.tenantId); }
}
