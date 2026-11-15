import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Context, parse } from '../../core/application/context.js';
import type { Actor } from '../../core/domain/models.js';
import { decrypt, encrypt } from './payment-security.js';
import { ownedOrder, payableOrder, reservePaymentRoute, settlePayment, type VerifiedPayment } from './order-payment.js';

interface Credentials { accessToken: string; publicKey: string; sellerId: string }
interface Attempt {
  id: string;
  totalCents: number;
  status: string;
  createdAt: number;
  submittedAt?: number;
  paymentId?: string;
  encryptedRequest?: string;
}
const formSchema = z.object({
  payment_method_id: z.string().regex(/^[a-zA-Z0-9_]{1,40}$/),
  token: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/).optional(),
  installments: z.number().int().min(1).max(24).optional(),
  issuer_id: z.union([z.string().regex(/^\d{1,30}$/), z.number().int().positive()]).optional(),
  payer: z.object({
    email: z.email().max(254),
    first_name: z.string().trim().max(100).optional(),
    last_name: z.string().trim().max(100).optional(),
    identification: z.object({
      type: z.enum(['CPF', 'CNPJ']), number: z.string().regex(/^\d{11}$|^\d{14}$/),
    }).optional(),
  }),
});
const submissionSchema = z.object({ attemptId: z.uuid(), formData: formSchema.optional() }).strict();
const terminal = (status: string) => ['rejected', 'cancelled'].includes(status);
class PaymentRequestRejected extends Error {}
const providerPayment = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  collector_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  external_reference: z.string(), status: z.string(), transaction_amount: z.number().positive(),
  currency_id: z.string(), live_mode: z.boolean(),
});

export class BricksCheckout {
  private readonly inFlight = new Set<string>();
  constructor(private readonly context: Context, private readonly credentials: (tenantId: string) => Promise<Credentials>) {}
  private get repo() { return this.context.repository; }
  private attempt(actor: Actor, orderId: string) {
    return this.repo.get<Attempt>(actor.tenantId, 'brick_attempts', orderId);
  }
  private present(attempt?: Attempt) {
    return attempt ? { attemptId: attempt.id, status: attempt.status, paymentId: attempt.paymentId } : undefined;
  }
  async prepare(actor: Actor, orderId: string) {
    const order = payableOrder(this.context, actor, orderId);
    // A previously issued Pro link can still collect money. Never create a second route for it.
    const legacy = this.repo.get<{ url: string }>(actor.tenantId, 'checkout_links', orderId);
    if (legacy) return { legacyUrl: legacy.url };
    reservePaymentRoute(this.context, actor.tenantId, orderId, 'bricks');
    const credentials = await this.credentials(actor.tenantId);
    if (!credentials.publicKey) throw new ServiceUnavailableException('A loja precisa autorizar novamente a conexão de pagamentos.');
    const attempt = this.repo.transaction(() => {
      const previous = this.attempt(actor, orderId);
      if (previous && !terminal(previous.status)) return previous;
      return this.repo.put<Attempt>(actor.tenantId, 'brick_attempts', orderId, {
        id: randomUUID(), totalCents: order.totalCents, status: 'ready', createdAt: Date.now(),
      });
    });
    return { publicKey: credentials.publicKey, amountCents: order.totalCents,
      payerEmail: actor.email, ...this.present(attempt) };
  }
  async pay(actor: Actor, orderId: string, input: unknown) {
    const order = payableOrder(this.context, actor, orderId);
    const submission = parse(submissionSchema, input);
    reservePaymentRoute(this.context, actor.tenantId, orderId, 'bricks');
    const credentials = await this.credentials(actor.tenantId);
    const lock = `${actor.tenantId}:${orderId}`;
    if (this.inFlight.has(lock)) throw new ConflictException('O pagamento está sendo processado. Aguarde a confirmação.');
    this.inFlight.add(lock);
    try {
      const attempt = this.repo.transaction(() => {
        const current = this.attempt(actor, orderId);
        if (!current || current.id !== submission.attemptId || current.totalCents !== order.totalCents)
          throw new ConflictException('Reabra o pagamento para conferir o pedido atualizado.');
        if (current.status !== 'ready') return current;
        if (!submission.formData) throw new BadRequestException('Preencha os dados do pagamento.');
        const form = submission.formData;
        const pix = form.payment_method_id === 'pix';
        if (!pix && (!form.token || !form.installments))
          throw new BadRequestException('Confira os dados do cartão.');
        const api = new URL(process.env.PUBLIC_API_URL || '');
        if (api.protocol !== 'https:') throw new ServiceUnavailableException('Pagamentos exigem uma API HTTPS.');
        const body = {
          transaction_amount: order.totalCents / 100,
          description: order.items.map(item => item.name).join(', ').slice(0, 240),
          external_reference: `${actor.tenantId}:${orderId}`,
          notification_url: `${api.toString().replace(/\/$/, '')}/payments/webhook`,
          payment_method_id: form.payment_method_id, payer: form.payer,
          ...(pix ? {} : { token: form.token, installments: form.installments, issuer_id: form.issuer_id }),
        };
        return this.repo.put<Attempt>(actor.tenantId, 'brick_attempts', orderId, {
          ...current, status: 'processing', submittedAt: Date.now(), encryptedRequest: encrypt(body),
        });
      });
      if (attempt.paymentId || terminal(attempt.status)) return this.present(attempt);
      if (!attempt.encryptedRequest) throw new ConflictException('Reabra o pagamento.');
      if (Date.now() - (attempt.submittedAt || attempt.createdAt) > 10 * 60_000)
        throw new ServiceUnavailableException('Esta tentativa precisa ser conferida pela loja antes de outra cobrança. Entre em contato com o estabelecimento.');
      // Persist the original tokenized request before I/O. Retries, including after restart,
      // replay that exact request/key rather than accepting a different card or creating a new charge.
      let payment: VerifiedPayment;
      try {
        payment = await this.request(credentials.accessToken, '/v1/payments',
          decrypt(attempt.encryptedRequest), attempt.id);
      } catch (error) {
        if (error instanceof PaymentRequestRejected) {
          this.repo.put<Attempt>(actor.tenantId, 'brick_attempts', orderId, {
            id: attempt.id, totalCents: attempt.totalCents, createdAt: attempt.createdAt, status: 'rejected',
          });
          throw new BadRequestException('O Mercado Pago não aceitou os dados desta tentativa. Confira os dados ou escolha outra forma de pagamento.');
        }
        throw error;
      }
      this.validateOrder(payment, actor, orderId);
      settlePayment(this.context, actor.tenantId, credentials.sellerId, payment);
      const saved: Attempt = {
        id: attempt.id, createdAt: attempt.createdAt, totalCents: attempt.totalCents, status: payment.status, paymentId: String(payment.id),
      };
      this.repo.transaction(() => {
        if (this.attempt(actor, orderId)?.id === attempt.id)
          this.repo.put(actor.tenantId, 'brick_attempts', orderId, saved);
      });
      return this.present(saved);
    } finally { this.inFlight.delete(lock); }
  }
  async status(actor: Actor, orderId: string) {
    const order = ownedOrder(this.context, actor, orderId);
    const attempt = this.attempt(actor, orderId);
    if (order.paymentStatus === 'paid') return { ...this.present(attempt), status: 'approved', paid: true };
    if (!attempt?.paymentId) return { ...this.present(attempt), paid: false };
    const credentials = await this.credentials(actor.tenantId);
    const payment = await this.request(credentials.accessToken, `/v1/payments/${encodeURIComponent(attempt.paymentId)}`);
    if (String(payment.id) !== attempt.paymentId) throw new BadRequestException('Resposta de pagamento incompatível.');
    this.validateOrder(payment, actor, orderId);
    settlePayment(this.context, actor.tenantId, credentials.sellerId, payment);
    this.repo.transaction(() => {
      const current = this.attempt(actor, orderId);
      if (current?.id === attempt.id)
        this.repo.put<Attempt>(actor.tenantId, 'brick_attempts', orderId, { ...current, status: payment.status });
    });
    return { ...this.present({ ...attempt, status: payment.status }),
      paid: ownedOrder(this.context, actor, orderId).paymentStatus === 'paid' };
  }
  private validateOrder(payment: VerifiedPayment, actor: Actor, orderId: string) {
    if (payment.external_reference !== `${actor.tenantId}:${orderId}`)
      throw new BadRequestException('Resposta de pagamento incompatível com o pedido.');
  }
  private async request(token: string, path: string, body?: unknown, key?: string): Promise<VerifiedPayment> {
    let response: Response;
    try {
      response = await fetch(`https://api.mercadopago.com${path}`, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
          ...(key ? { 'X-Idempotency-Key': key } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ServiceUnavailableException('Ainda não conseguimos confirmar o pagamento. Use Verificar pagamento antes de tentar outra compra.');
    }
    if (!response.ok) {
      if (body && [400, 401, 403, 404, 422].includes(response.status)) throw new PaymentRequestRejected();
      throw new ServiceUnavailableException('O pagamento aguarda verificação. Confira a situação antes de tentar outra compra.');
    }
    const parsed = providerPayment.safeParse(await response.json());
    if (!parsed.success) throw new ServiceUnavailableException('Não foi possível confirmar a resposta do pagamento.');
    return parsed.data;
  }
}
