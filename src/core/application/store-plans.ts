import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Repository } from '../domain/document-repository.js';
import type { Actor } from '../domain/models.js';

export const STORE_PLANS = [
  { id: 'essencial', name: 'Essencial', priceCents: 5990, employees: 1, monthlyEmails: 1000, dailyEmails: 100 },
  { id: 'profissional', name: 'Profissional', priceCents: 7990, employees: 5, monthlyEmails: 2500, dailyEmails: 200 },
  { id: 'equipe', name: 'Equipe', priceCents: 9990, employees: 10, monthlyEmails: 5000, dailyEmails: 400 },
] as const;
export type PlanId = typeof STORE_PLANS[number]['id'];
export const findPlan = (id: string) => STORE_PLANS.find(plan => plan.id === id);
export interface Trial { startedAt: number; endsAt: number }
export interface StoreSubscription {
  id: string; planId: PlanId; priceCents: number; url: string; status: string;
  externalReference: string; paidThrough?: number; checkedAt?: string;
}

/** Called inside the account creation transaction. Customers never receive a trial or billing record. */
export function startStoreTrial(repo: Repository, owner: Pick<Actor, 'tenantId' | 'email'>, now = Date.now()) {
  if (repo.get(owner.tenantId, 'billing', 'trial')) return;
  const ownerKey = createHash('sha256').update(owner.email.trim().toLowerCase()).digest('hex');
  const claimed = repo.get<Trial>('system', 'store_trial_owners', ownerKey);
  const trial: Trial = claimed || { startedAt: now, endsAt: now + 14 * 86400000 };
  repo.put(owner.tenantId, 'billing', 'trial', trial);
  if (!claimed) repo.put('system', 'store_trial_owners', ownerKey, trial);
}

export function storeEntitlement(repo: Repository, tenantId: string, now = Date.now()) {
  const trial = repo.get<Trial>(tenantId, 'billing', 'trial');
  const subscription = repo.get<StoreSubscription>(tenantId, 'billing', 'subscription');
  const plan = subscription?.planId && findPlan(subscription.planId);
  if (plan && (subscription.paidThrough || 0) > now)
    return { mode: 'active' as const, plan, expiresAt: subscription.paidThrough!, trialEndsAt: trial?.endsAt };
  if (trial && trial.endsAt > now)
    return { mode: 'trial' as const, plan: STORE_PLANS[2], expiresAt: trial.endsAt, trialEndsAt: trial.endsAt };
  if (!trial && !subscription?.planId)
    return { mode: 'pilot' as const, plan: null, expiresAt: null, trialEndsAt: undefined };
  return { mode: 'expired' as const, plan: null, expiresAt: null, trialEndsAt: trial?.endsAt };
}

export function requireStoreService(repo: Repository, tenantId: string, now = Date.now()) {
  if (storeEntitlement(repo, tenantId, now).mode === 'expired')
    throw new ForbiddenException('O período de uso da loja terminou. O responsável precisa contratar um plano para receber novos agendamentos e pedidos. Clientes não pagam assinatura.');
}

/** One seat per active employee or additional professional; principal (owner) does not use a seat. */
export function employeeSeats(repo: Repository, tenantId: string) {
  const seats = new Set<string>();
  const employees = repo.list<Actor>(tenantId, 'customers').filter(user => user.role === 'employee' && user.active !== false);
  const linked = new Set(employees.map(user => user.professionalId).filter(Boolean));
  employees.forEach(user => seats.add(user.professionalId || `user:${user.id}`));
  for (const professional of repo.list<{ id: string; active: boolean }>(tenantId, 'professionals'))
    if (professional.id !== 'principal' && professional.active && !linked.has(professional.id)) seats.add(professional.id);
  return seats.size;
}

export function requireEmployeeSeat(repo: Repository, tenantId: string) {
  requireStoreService(repo, tenantId);
  const entitlement = storeEntitlement(repo, tenantId);
  if (entitlement.plan && employeeSeats(repo, tenantId) >= entitlement.plan.employees)
    throw new ForbiddenException(`Seu plano permite até ${entitlement.plan.employees} funcionário(s) ativo(s). Desative um acesso ou escolha um plano maior.`);
}
