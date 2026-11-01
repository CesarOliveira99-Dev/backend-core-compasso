import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Context, id, parse } from '../../../core/application/context.js';
import type { Actor, Customer, Settings } from '../../../core/domain/models.js';
import {
  credentialsSchema,
  hashPassword,
  registrationSchema,
  verifyPassword,
} from './identity.schemas.js';
@Injectable()
export class IdentityService {
  private attempts = new Map<string, { count: number; since: number }>();
  constructor(private readonly context: Context) {}
  publicUser(customer: Customer): Actor {
    const { id, tenantId, role, name, email, phone } = customer;
    return { id, tenantId, role, name, email, phone };
  }
  register(body: unknown) {
    const input = parse(registrationSchema, body);
    if (!/^[a-z0-9-]+$/.test(input.slug))
      throw new BadRequestException(
        'O código da loja deve conter letras minúsculas, números e hífens.',
      );
    return this.context.repository.transaction(() => {
      let store = this.context.repository.get<{ tenantId: string }>('system', 'stores', input.slug);
      if (input.role === 'admin' && store)
        throw new ConflictException('Este código de loja já está em uso.');
      if (input.role === 'customer' && !store)
        throw new BadRequestException('Loja não encontrada. Confira o código.');
      const tenantId = store?.tenantId || id();
      if (this.context.repository.get('system', 'accounts', `${input.slug}:${input.email}`))
        throw new ConflictException('E-mail já cadastrado nesta loja.');
      const customer: Customer = {
        id: id(),
        tenantId,
        role: input.role,
        name: input.name,
        email: input.email,
        phone: input.phone,
        passwordHash: hashPassword(input.password),
        addresses: [],
      };
      this.context.repository.put(tenantId, 'customers', customer.id, customer);
      this.context.repository.put('system', 'accounts', `${input.slug}:${input.email}`, {
        tenantId,
        userId: customer.id,
      });
      if (!store) {
        this.context.repository.put('system', 'stores', input.slug, { tenantId });
        const settings: Settings = {
          name: input.name,
          businessName: input.businessName || input.name,
          slug: input.slug,
          timezone: 'America/Sao_Paulo',
          completionMode: 'manual',
          payOnAppointment: true,
          payOnDelivery: true,
          bankAccount: '',
          pixKey: '',
          openingHour: 8,
          closingHour: 20,
          workDays: [0, 1, 2, 3, 4, 5, 6],
        };
        this.context.repository.put(tenantId, 'settings', 'business', settings);
      }
      return this.session(customer);
    });
  }
  login(body: unknown) {
    const input = parse(credentialsSchema, body);
    const key = `${input.slug}:${input.email}`;
    const attempt = this.attempts.get(key);
    if (attempt && Date.now() - attempt.since < 60000 && attempt.count >= 8)
      throw new UnauthorizedException('Aguarde um minuto antes de tentar novamente.');
    if (!attempt || Date.now() - attempt.since >= 60000)
      this.attempts.set(key, { count: 1, since: Date.now() });
    else attempt.count++;
    if (this.attempts.size > 10000) this.attempts.clear();
    const account = this.context.repository.get<{ tenantId: string; userId: string }>(
      'system',
      'accounts',
      key,
    );
    const customer =
      account &&
      this.context.repository.get<Customer>(account.tenantId, 'customers', account.userId);
    if (!customer || !verifyPassword(input.password, customer.passwordHash))
      throw new UnauthorizedException('E-mail, senha ou código da loja inválidos.');
    this.attempts.delete(key);
    return this.session(customer);
  }
  session(customer: Customer) {
    const token = randomBytes(32).toString('hex');
    this.context.repository.put(
      'system',
      'sessions',
      createHash('sha256').update(token).digest('hex'),
      {
        userId: customer.id,
        tenantId: customer.tenantId,
        expiresAt: Date.now() + 1000 * 60 * 60 * 24,
      },
    );
    return { token, user: this.publicUser(customer) };
  }
  authenticate(token: string): Actor {
    const session = this.context.repository.get<{
      userId: string;
      tenantId: string;
      expiresAt: number;
    }>('system', 'sessions', createHash('sha256').update(token).digest('hex'));
    if (!session || session.expiresAt < Date.now())
      throw new UnauthorizedException('Sua sessão expirou. Entre novamente.');
    const customer = this.context.repository.get<Customer>(
      session.tenantId,
      'customers',
      session.userId,
    );
    if (!customer) throw new UnauthorizedException();
    return this.publicUser(customer);
  }
  logout(token: string) {
    this.context.repository.remove(
      'system',
      'sessions',
      createHash('sha256').update(token).digest('hex'),
    );
    return { ok: true };
  }
}
