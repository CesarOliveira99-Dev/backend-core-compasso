import type { Repository } from '../domain/document-repository.js';
import { localDate } from '../domain/policies.js';
import { storeEntitlement } from './store-plans.js';
import type { Context } from './context.js';
import type { Actor } from '../domain/models.js';

interface Reservation { day: string; month: string; state: 'reserved' | 'sent'; attempts?: number }
const period = (now: number) => { const day = localDate(new Date(now), 'America/Sao_Paulo'); return { day, month: day.slice(0, 7) }; };
const count = (repo: Repository, tenant: string, key: string) => repo.get<{ count: number }>(tenant, 'email_usage', key)?.count || 0;

export function emailQuota(repo: Repository, tenantId: string, now = Date.now()) {
  const entitlement = storeEntitlement(repo, tenantId, now);
  const { day, month } = period(now);
  return { timezone: 'America/Sao_Paulo', day, month,
    daily: { used: count(repo, tenantId, day), limit: entitlement.mode === 'pilot' ? null : entitlement.plan?.dailyEmails || 0 },
    monthly: { used: count(repo, tenantId, month), limit: entitlement.mode === 'pilot' ? null : entitlement.plan?.monthlyEmails || 0 } };
}

/** Reserve before external I/O. Unknown deliveries retain the slot and retry with the same provider key. */
export function reserveEmail(repo: Repository, tenantId: string, jobId: string, now = Date.now()) {
  return repo.transaction(() => {
    if (repo.get<Reservation>(tenantId, 'email_reservations', jobId)) return true;
    const usage = emailQuota(repo, tenantId, now);
    if ((usage.daily.limit !== null && usage.daily.used >= usage.daily.limit) ||
      (usage.monthly.limit !== null && usage.monthly.used >= usage.monthly.limit)) return false;
    for (const key of [usage.day, usage.month])
      repo.put(tenantId, 'email_usage', key, { count: count(repo, tenantId, key) + 1 });
    repo.put<Reservation>(tenantId, 'email_reservations', jobId, { day: usage.day, month: usage.month, state: 'reserved' });
    return true;
  });
}

export function finishEmail(repo: Repository, tenantId: string, jobId: string, accepted: boolean) {
  repo.transaction(() => {
    const reservation = repo.get<Reservation>(tenantId, 'email_reservations', jobId);
    if (!reservation || reservation.state === 'sent') return;
    if (accepted) repo.put(tenantId, 'email_reservations', jobId, { ...reservation, state: 'sent' });
    else if ((reservation.attempts || 0) <= 1) {
      for (const key of [reservation.day, reservation.month])
        repo.put(tenantId, 'email_usage', key, { count: Math.max(0, count(repo, tenantId, key) - 1) });
      repo.remove(tenantId, 'email_reservations', jobId);
    }
  });
}

/** Persist before I/O so a crash or unknown earlier delivery cannot later release its slot. */
export function beginEmailAttempt(repo: Repository, tenantId: string, jobId: string) {
  const reservation = repo.get<Reservation>(tenantId, 'email_reservations', jobId);
  if (reservation) repo.put(tenantId, 'email_reservations', jobId, { ...reservation, attempts: (reservation.attempts || 0) + 1 });
}

export function notifyEmailQuota(context: Context, tenantId: string, now = Date.now()) {
  const usage = emailQuota(context.repository, tenantId, now);
  for (const [periodKey, quota, label] of [[usage.day, usage.daily, 'diária'], [usage.month, usage.monthly, 'mensal']] as const) {
    if (!quota.limit) continue;
    const threshold = quota.used >= quota.limit ? 100 : quota.used >= quota.limit * .8 ? 80 : 0;
    if (!threshold) continue;
    for (const admin of context.repository.list<Actor>(tenantId, 'customers').filter(user => user.role === 'admin'))
      context.notify(admin, admin.id, `Franquia de e-mails: ${threshold}%`,
        `Sua franquia ${label} atingiu ${threshold}%. Os agendamentos continuam disponíveis. Não haverá cobrança de excedentes; os e-mails aguardam a renovação da franquia.`,
        `email-quota:${periodKey}:${threshold}`);
  }
}
