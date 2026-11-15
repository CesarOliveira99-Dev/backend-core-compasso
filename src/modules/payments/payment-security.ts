import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

function key() {
  const value = Buffer.from(process.env.PAYMENTS_ENCRYPTION_KEY || '', 'base64');
  if (value.length !== 32)
    throw new Error('Configure PAYMENTS_ENCRYPTION_KEY com 32 bytes em base64.');
  return value;
}
export function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function decrypt<T>(value: string): T {
  const data = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
}
export function validSignature(
  dataId: string,
  requestId: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !dataId || !requestId) return false;
  const parts = Object.fromEntries(signature.split(',').map((p) => p.split('=')));
  if (!/^\d+$/.test(parts.ts || '') || !/^[a-f0-9]{64}$/i.test(parts.v1 || '')) return false;
  // Mercado Pago timestamps can be expressed in seconds or milliseconds.
  const time = Number(parts.ts) * (parts.ts.length <= 10 ? 1000 : 1);
  if (Math.abs(Date.now() - time) > 10 * 60_000) return false;
  const expected = createHmac('sha256', secret)
    .update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`)
    .digest();
  return timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}
