import {RecommendationAddon} from './recommendation-addon.js';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Context, timestamp } from '../../core/application/context.js';
import type { Actor, Appointment, Order, Triage } from '../../core/domain/models.js';
import { decrypt, encrypt, validSignature } from './payment-security.js';

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id: number;
}
interface Connection {
  userId: string;
  encrypted: string;
  expiresAt: number;
}
const platform = '__compasso_payments__';
function configured(name: string) {
  const value = process.env[name];
  if (!value)
    throw new ServiceUnavailableException('Integração de pagamentos ainda não configurada.');
  return value;
}
function httpsUrl(name: string) {
  const url = new URL(configured(name));
  if (url.protocol !== 'https:')
    throw new ServiceUnavailableException('Pagamentos exigem URLs públicas HTTPS.');
  return url.toString().replace(/\/$/, '');
}
export function billingPrice(): number {
  const price = Number(process.env.COMPASSO_MONTHLY_PRICE_CENTS || 0);
  return Number.isSafeInteger(price) && price > 0 ? price : 0;
}
@Injectable()
export class PaymentsService {
  readonly addon: RecommendationAddon;
  constructor(private readonly context: Context) { this.addon=new RecommendationAddon(context,this.call.bind(this)); }
  private get repo() {
    return this.context.repository;
  }
  private connection(tenantId: string) {
    return this.repo.get<Connection>(tenantId, 'payment_connections', 'mercadopago');
  }
  status(actor: Actor) {
    this.context.admin(actor);
    return {
      configured: Boolean(
        process.env.MP_CLIENT_ID &&
        process.env.MP_CLIENT_SECRET &&
        process.env.PAYMENTS_ENCRYPTION_KEY &&
        process.env.MP_WEBHOOK_SECRET &&
        process.env.PUBLIC_API_URL &&
        process.env.APP_URL,
      ),
      connected: Boolean(this.connection(actor.tenantId)),
      monthlyPriceCents: billingPrice(),
      billingEnabled: Boolean(billingPrice() && process.env.MP_PLATFORM_ACCESS_TOKEN),
      subscription: this.repo.get(actor.tenantId, 'billing', 'subscription') || null,
    };
  }
  async connect(actor: Actor) {
    this.context.admin(actor);
    configured('MP_CLIENT_SECRET');
    configured('MP_WEBHOOK_SECRET');
    encrypt('configuration-check');
    const state = randomBytes(32).toString('hex');
    const verifier = randomBytes(48).toString('base64url');
    this.repo.put(platform, 'oauth_states', createHash('sha256').update(state).digest('hex'), {
      tenantId: actor.tenantId,
      verifier,
      expiresAt: Date.now() + 10 * 60_000,
    });
    const query = new URLSearchParams({
      client_id: configured('MP_CLIENT_ID'),
      response_type: 'code',
      platform_id: 'mp',
      state,
      redirect_uri: `${httpsUrl('PUBLIC_API_URL')}/payments/callback`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return { url: `https://auth.mercadopago.com/authorization?${query}` };
  }
  async callback(state: string, code: string) {
    const hash = createHash('sha256').update(state).digest('hex');
    const pending = this.repo.transaction(() => {
      const record = this.repo.get<{ tenantId: string; verifier: string; expiresAt: number }>(
        platform,
        'oauth_states',
        hash,
      );
      if (!record || record.expiresAt < Date.now())
        throw new BadRequestException('Conexão expirada. Inicie novamente nas configurações.');
      this.repo.remove(platform, 'oauth_states', hash);
      return record;
    });
    const tokens = await this.call<Tokens>('/oauth/token', undefined, {
      client_id: configured('MP_CLIENT_ID'),
      client_secret: configured('MP_CLIENT_SECRET'),
      grant_type: 'authorization_code',
      code,
      code_verifier: pending.verifier,
      redirect_uri: `${httpsUrl('PUBLIC_API_URL')}/payments/callback`,
    });
    const userId = String(tokens.user_id);
    this.repo.transaction(() => {
      const owner = this.repo.get<{ tenantId: string }>(platform, 'merchants', userId);
      if (owner && owner.tenantId !== pending.tenantId)
        throw new BadRequestException('Esta conta já está vinculada a outra loja.');
      const existing = this.connection(pending.tenantId);
      if (existing && existing.userId !== userId)
        throw new BadRequestException('A loja já possui outra conta vinculada.');
      this.repo.put(pending.tenantId, 'payment_connections', 'mercadopago', {
        userId,
        encrypted: encrypt(tokens),
        expiresAt: Date.now() + tokens.expires_in * 1000,
      });
      this.repo.put(platform, 'merchants', userId, { tenantId: pending.tenantId });
    });
    return `${httpsUrl('APP_URL')}/?payment_connection=success`;
  }
  private async access(tenantId: string) {
    const connection = this.connection(tenantId);
    if (!connection)
      throw new BadRequestException('O comerciante ainda não conectou o Mercado Pago.');
    let tokens = decrypt<Tokens>(connection.encrypted);
    if (connection.expiresAt < Date.now() + 60_000) {
      tokens = await this.call<Tokens>('/oauth/token', undefined, {
        client_id: configured('MP_CLIENT_ID'),
        client_secret: configured('MP_CLIENT_SECRET'),
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      });
      this.repo.put(tenantId, 'payment_connections', 'mercadopago', {
        userId: connection.userId,
        encrypted: encrypt(tokens),
        expiresAt: Date.now() + tokens.expires_in * 1000,
      });
    }
    return tokens.access_token;
  }
  async checkout(actor: Actor, orderId: string) {
    const order = this.context.require<Order>(actor, 'orders', orderId);
    this.context.owned(actor, order.customerId);
    if (
      order.paymentMethod !== 'online' ||
      order.paymentStatus === 'paid' ||
      order.status === 'cancelled' ||
      order.totalCents <= 0
    )
      throw new BadRequestException('Este pedido não está disponível para pagamento online.');
    if (
      this.repo
        .list<Triage>(actor.tenantId, 'triage')
        .some((t) => t.orderId === orderId && t.status !== 'approved')
    )
      throw new BadRequestException('Aguarde a aprovação da triagem antes de pagar.');
    if (
      this.repo
        .list<Appointment>(actor.tenantId, 'appointments')
        .some((a) => a.orderId === orderId && (a.status === 'pending' || a.status === 'cancelled'))
    )
      throw new BadRequestException(
        'Resolva a triagem ou o cancelamento dos atendimentos antes de pagar.',
      );
    const previous = this.repo.get<{ url: string }>(actor.tenantId, 'checkout_links', orderId);
    if (previous) return previous;
    const token = await this.access(actor.tenantId);
    const appUrl = httpsUrl('APP_URL');
    const result = await this.call<{ id: string; init_point: string; sandbox_init_point: string }>(
      '/checkout/preferences',
      token,
      {
        items: order.items.map((item) => ({
          id: item.itemId,
          title: item.name,
          quantity: item.quantity,
          currency_id: 'BRL',
          unit_price: item.unitPriceCents / 100,
        })),
        external_reference: `${actor.tenantId}:${order.id}`,
        notification_url: `${httpsUrl('PUBLIC_API_URL')}/payments/webhook`,
        back_urls: { success: appUrl, pending: appUrl, failure: appUrl },
        auto_return: 'approved',
      },
      order.id,
    );
    const link = {
      providerId: result.id,
      url: process.env.MP_SANDBOX === 'true' ? result.sandbox_init_point : result.init_point,
    };
    this.repo.put(actor.tenantId, 'checkout_links', orderId, link);
    return link;
  }
  async subscribe(actor: Actor) {
    this.context.admin(actor);
    const price = billingPrice();
    if (!price) throw new BadRequestException('O plano do Compasso ainda não foi disponibilizado.');
    const previous = this.repo.get<{ id: string; url: string; status: string }>(
      actor.tenantId,
      'billing',
      'subscription',
    );
    if (previous && previous.status !== 'cancelled') return previous;
    const result = await this.call<{ id: string; init_point: string; status: string }>(
      '/preapproval',
      configured('MP_PLATFORM_ACCESS_TOKEN'),
      {
        reason: 'Assinatura mensal Compasso',
        external_reference: actor.tenantId,
        payer_email: actor.email,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: price / 100,
          currency_id: 'BRL',
        },
        back_url: httpsUrl('APP_URL'),
        status: 'pending',
      },
      `subscription-${actor.tenantId}`,
    );
    return this.repo.put(actor.tenantId, 'billing', 'subscription', {
      id: result.id,
      url: result.init_point,
      status: result.status,
      priceCents: price,
    });
  }
  async refreshSubscription(actor: Actor) {
    this.context.admin(actor);
    const subscription = this.context.require<{ id: string; url: string; priceCents: number }>(
      actor,
      'billing',
      'subscription',
    );
    const result = await this.call<{ status: string; external_reference: string }>(
      '/preapproval/' + encodeURIComponent(subscription.id),
      configured('MP_PLATFORM_ACCESS_TOKEN'),
    );
    if (result.external_reference !== actor.tenantId) throw new ForbiddenException();
    return this.repo.put(actor.tenantId, 'billing', 'subscription', {
      ...subscription,
      status: result.status,
      checkedAt: timestamp(),
    });
  }
  async webhook(
    dataId: string,
    requestId: string,
    signature: string,
    body: { type?: string; user_id?: number },
  ) {
    if (!validSignature(dataId, requestId, signature, configured('MP_WEBHOOK_SECRET')))
      throw new ForbiddenException('Assinatura inválida.');
    if (body.type !== 'payment') return { received: true };
    if(process.env.MP_PLATFORM_USER_ID && String(body.user_id)===process.env.MP_PLATFORM_USER_ID && process.env.MP_PLATFORM_ACCESS_TOKEN) return this.addon.webhook(dataId);
    const merchant = this.repo.get<{ tenantId: string }>(
      platform,
      'merchants',
      String(body.user_id),
    );
    if (!merchant) return { received: true };
    const payment = await this.call<{
      id: number;
      collector_id: number;
      external_reference: string;
      status: string;
      transaction_amount: number;
      currency_id: string;
      live_mode: boolean;
    }>(`/v1/payments/${encodeURIComponent(dataId)}`, await this.access(merchant.tenantId));
    const connection = this.connection(merchant.tenantId)!;
    if (String(payment.collector_id) !== connection.userId || payment.currency_id !== 'BRL')
      throw new ForbiddenException();
    if (payment.live_mode !== (process.env.MP_SANDBOX !== 'true'))
      throw new BadRequestException('Ambiente de pagamento incompatível.');
    const prefix = `${merchant.tenantId}:`;
    if (!payment.external_reference?.startsWith(prefix))
      throw new BadRequestException('Pedido inválido.');
    const orderId = payment.external_reference.slice(prefix.length);
    this.repo.transaction(() => {
      const order = this.repo.get<Order>(merchant.tenantId, 'orders', orderId);
      if (
        !order ||
        order.paymentMethod !== 'online' ||
        Math.round(payment.transaction_amount * 100) !== order.totalCents
      )
        throw new BadRequestException('Valor ou pedido incompatível.');
      const other = this.repo.get<{ paymentId: string }>(merchant.tenantId, 'settlements', orderId);
      if (other && other.paymentId !== String(payment.id))
        throw new BadRequestException('Pedido já possui outro pagamento.');
      if (payment.status === 'approved' && order.status !== 'cancelled') {
        order.paymentStatus = 'paid';
        order.paidAt ??= timestamp();
        this.repo.put(merchant.tenantId, 'settlements', orderId, { paymentId: String(payment.id) });
      } else if (['refunded', 'charged_back'].includes(payment.status) && other) {
        order.paymentStatus = 'pending';
        order.paidAt = undefined;
      }
      this.repo.put(merchant.tenantId, 'orders', orderId, order);
      for (const appointment of this.repo
        .list<Appointment>(merchant.tenantId, 'appointments')
        .filter((a) => a.orderId === orderId && a.status !== 'cancelled'))
        this.repo.put(merchant.tenantId, 'appointments', appointment.id, {
          ...appointment,
          paymentStatus: order.paymentStatus,
          paidAt: order.paidAt,
        });
      this.repo.put(merchant.tenantId, 'payment_events', String(payment.id), {
        status: payment.status,
        orderId,
        checkedAt: timestamp(),
      });
    });
    return { received: true };
  }
  private async call<T>(
    path: string,
    token?: string,
    body?: unknown,
    idempotency?: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.mercadopago.com${path}`, {
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(idempotency ? { 'X-Idempotency-Key': idempotency } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ServiceUnavailableException('Mercado Pago indisponível. Tente novamente.');
    }
    if (!response.ok)
      throw new ServiceUnavailableException(
        'Não foi possível concluir no Mercado Pago. Confira a configuração e tente novamente.',
      );
    return (await response.json()) as T;
  }
}
