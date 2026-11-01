export interface MessageGateway {
  send(input: {
    recipient: string;
    templateId: string;
    parameters: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}
export const MESSAGE_GATEWAY = Symbol('MESSAGE_GATEWAY');
