import { isSolo } from './workspace-policy.js';
import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Repository } from '../domain/document-repository.js';
import type { Actor } from '../domain/models.js';

export const STORE_PLANS = [
  { id: 'essencial', name: 'Essencial', priceCents: 5990, employees: 1, monthlyEmails: 1000, dailyEmails: 100 },
  { id: 'profissional', name: 'Profissional', priceCents: 7990, employees: 5, monthlyEmails: 2500, dailyEmails: 200 },
  { id: 'equipe', name: 'Equipe', priceCents: 9990, employees: 10, monthlyEmails: 5000, dailyEmails: 400, extraEmployeePriceCents: 2500 },
] as const;
export const SOLO_PLANS = [
  { id: 'solo-mensal', name: 'Solo mensal', priceCents: 1500, employees: 0, monthlyEmails: 0, dailyEmails: 0, periodMonths: 1 },
  { id: 'solo-anual', name: 'Solo anual', priceCents: 11000, employees: 0, monthlyEmails: 0, dailyEmails: 0, periodMonths: 12 },
] as const;
const ALL_PLANS = [...STORE_PLANS, ...SOLO_PLANS];
export type PlanId = typeof ALL_PLANS[number]['id'];
export const findPlan = (id: string) => ALL_PLANS.find(plan => plan.id === id);
export function planPrice(planId: PlanId, extraEmployees = 0) {
  if (!Number.isSafeInteger(extraEmployees) || extraEmployees < 0 || extraEmployees > 90 || (planId !== 'equipe' && extraEmployees !== 0))
    throw new ForbiddenException('Colaboradores extras estão disponíveis somente no plano Equipe, até 100 colaboradores no total.');
  return findPlan(planId)!.priceCents + extraEmployees * STORE_PLANS[2].extraEmployeePriceCents;
}
export interface Trial { startedAt: number; endsAt: number }
export interface StoreSubscription {
  id: string; planId: PlanId; priceCents: number; url: string; status: string;
  externalReference: string; paidThrough?: number; checkedAt?: string;
  extraEmployees?: number;
  periodMonths?: number;
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
    return { mode: 'active' as const, plan: { ...plan, employees: plan.employees + (subscription.extraEmployees || 0), priceCents: subscription.priceCents }, expiresAt: subscription.paidThrough!, trialEndsAt: trial?.endsAt };
  if (trial && trial.endsAt > now)
    return { mode: 'trial' as const, plan: isSolo(repo, tenantId) ? SOLO_PLANS[0] : STORE_PLANS[2], expiresAt: trial.endsAt, trialEndsAt: trial.endsAt };
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
  if (repo.get(tenantId, 'billing', 'extras_change'))
    throw new ForbiddenException('Aguarde a confirmação da alteração de colaboradores extras antes de incluir ou reativar um colaborador.');
  const entitlement = storeEntitlement(repo, tenantId);
  if (entitlement.plan && employeeSeats(repo, tenantId) >= entitlement.plan.employees) {
    if (entitlement.mode === 'active' && entitlement.plan.id === 'equipe')
      throw new ForbiddenException('Limite de colaboradores atingido. O dono da loja pode confirmar mais uma vaga por R$25,00 mensais na área de equipe ou nos planos antes de incluir este colaborador.');
    throw new ForbiddenException(`Seu plano permite até ${entitlement.plan.employees} funcionário(s) ativo(s). Desative um acesso ou escolha um plano maior.`);
  }
}
