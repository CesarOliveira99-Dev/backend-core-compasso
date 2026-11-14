import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

@Injectable()
export class GoogleIdentity {
  private readonly client = new OAuth2Client();
  async verify(credential: string, nonce: string) {
    const audience = process.env.GOOGLE_CLIENT_ID;
    if (!audience) throw new ServiceUnavailableException('Login com Google ainda não configurado.');
    try {
      const ticket = await this.client.verifyIdToken({ idToken: credential, audience });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || !payload.email_verified || payload.nonce !== nonce)
        throw new Error('Invalid identity');
      return {
        sub: payload.sub,
        email: payload.email.toLowerCase(),
        name: payload.name || payload.email,
      };
    } catch {
      throw new UnauthorizedException(
        'Não foi possível validar sua conta Google. Tente novamente.',
      );
    }
  }
}
