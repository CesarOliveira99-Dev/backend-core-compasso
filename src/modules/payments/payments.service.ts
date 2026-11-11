import { SubscriptionBilling } from './subscription-billing.js';
import { BricksCheckout } from './bricks-checkout.js';
import { payableOrder, reservePaymentRoute, settlePayment } from './order-payment.js';
import {RecommendationAddon} from './recommendation-addon.js';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Context } from '../../core/application/context.js';
import type { Actor } from '../../core/domain/models.js';
import { decrypt, encrypt, validSignature } from './payment-security.js';

interface Tokens {
  access_token: string;
  public_key?: string;
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
@Injectable()
export class PaymentsService {
  readonly billing: SubscriptionBilling;
  readonly addon: RecommendationAddon;
  readonly bricks: BricksCheckout;
  constructor(private readonly context: Context) {
    this.billing = new SubscriptionBilling(context, this.call.bind(this));
    this.addon = new RecommendationAddon(context, this.call.bind(this));
    this.bricks = new BricksCheckout(context, async tenantId => {
      const accessToken = await this.access(tenantId);
      const connection = this.connection(tenantId)!;
      const tokens = decrypt<Tokens>(connection.encrypted);
      return { accessToken, publicKey: tokens.public_key || process.env.MP_PUBLIC_KEY || '', sellerId: connection.userId };
    });
  }
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
      ...this.billing.status(actor),
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
      const previousPublicKey = tokens.public_key;
      tokens = await this.call<Tokens>('/oauth/token', undefined, {
        client_id: configured('MP_CLIENT_ID'),
        client_secret: configured('MP_CLIENT_SECRET'),
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      });
      tokens.public_key ||= previousPublicKey;
      this.repo.put(tenantId, 'payment_connections', 'mercadopago', {
        userId: connection.userId,
        encrypted: encrypt(tokens),
        expiresAt: Date.now() + tokens.expires_in * 1000,
      });
    }
    return tokens.access_token;
  }
  async checkout(actor: Actor, orderId: string) {
    const order = payableOrder(this.context, actor, orderId);
    reservePaymentRoute(this.context, actor.tenantId, orderId, 'pro');
    if (this.repo.get(actor.tenantId, 'brick_attempts', orderId))
      throw new BadRequestException('Continue o pagamento na janela do pedido.');
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
  subscribe(actor: Actor, body: unknown) { return this.billing.subscribe(actor, body); }
  refreshSubscription(actor: Actor) { return this.billing.refresh(actor); }
  async webhook(
    dataId: string,
    requestId: string,
    signature: string,
    body: { type?: string; user_id?: number },
  ) {
    if (!validSignature(dataId, requestId, signature, configured('MP_WEBHOOK_SECRET')))
      throw new ForbiddenException('Assinatura inválida.');
    if (body.type === 'subscription_preapproval') { await this.billing.preapproval(dataId); return { received: true }; }
    if (body.type === 'subscription_authorized_payment') { await this.billing.invoice(dataId); return { received: true }; }
    if (body.type !== 'payment') return { received: true };
    if (process.env.MP_PLATFORM_USER_ID && String(body.user_id) === process.env.MP_PLATFORM_USER_ID && process.env.MP_PLATFORM_ACCESS_TOKEN) {
      if (this.billing.enabled() && await this.billing.payment(dataId)) return { received: true };
      const payment = await this.call<{ external_reference?: string }>(
        '/v1/payments/' + encodeURIComponent(dataId), process.env.MP_PLATFORM_ACCESS_TOKEN);
      if (payment.external_reference?.startsWith('compasso-addon:')) return this.addon.webhook(dataId);
    }
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
    settlePayment(this.context, merchant.tenantId, this.connection(merchant.tenantId)!.userId, payment);
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
