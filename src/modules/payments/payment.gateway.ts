// Implement and bind an adapter only after a provider has been selected.
// Bank and Pix settings alone never enable online payments.
export interface PaymentGateway {
  createCheckout(input: {
    orderId: string;
    amountCents: number;
    currency: 'BRL';
    idempotencyKey: string;
  }): Promise<{ providerId: string; checkoutUrl: string }>;
  verifyWebhook(
    rawBody: Uint8Array,
    headers: Record<string, string>,
  ): Promise<{
    eventId: string;
    providerId: string;
    amountCents: number;
    currency: 'BRL';
    status: 'paid' | 'failed' | 'pending';
  }>;
}
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
