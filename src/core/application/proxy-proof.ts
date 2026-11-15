import { createHmac, timingSafeEqual } from "node:crypto";
export interface ProxyProof {
  id?: string;
  time?: string;
  signature?: string;
}
export function verifiedProxyVisitor(
  proof: ProxyProof,
  method: string,
  path: string,
  secret: string | undefined,
  now = Date.now(),
) {
  if (
    !secret ||
    secret.length < 32 ||
    !/^v1:[a-f0-9]{64}$/.test(proof.id || "") ||
    !/^\d{13}$/.test(proof.time || "") ||
    !/^[a-f0-9]{64}$/.test(proof.signature || "")
  )
    return undefined;
  if (Math.abs(now - Number(proof.time)) > 30000) return undefined;
  const expected = createHmac("sha256", secret)
    .update(
      `proxy-v1\n${proof.time}\n${method.toUpperCase()}\n${path}\n${proof.id}`,
    )
    .digest();
  return timingSafeEqual(expected, Buffer.from(proof.signature!, "hex"))
    ? proof.id
    : undefined;
}
export function authenticationMutation(path: string, method: string) {
  return (
    method === "POST" &&
    /^\/v1\/auth\/(login|register|google(?:\/complete)?|invite\/register|password\/request|account\/complete)$/.test(
      path,
    )
  );
}
