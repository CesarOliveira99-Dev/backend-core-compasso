import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor, Notification, Settings } from '../domain/models.js';
import { REPOSITORY, type Repository } from '../domain/document-repository.js';
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return result.data;
}
export const id = (): string => randomUUID();
export const timestamp = () => new Date().toISOString();
@Injectable()
export class Context {
  constructor(@Inject(REPOSITORY) readonly repository: Repository) {}
  admin(actor: Actor): void {
    if (actor.role !== 'admin') throw new ForbiddenException('Acesso exclusivo do administrador.');
  }
  owned(actor: Actor, customerId: string): void {
    if (actor.role !== 'admin' && actor.id !== customerId)
      throw new ForbiddenException('Este registro pertence a outro cliente.');
  }
  settings(actor: Actor): Settings {
    return this.require<Settings>(actor, 'settings', 'business');
  }
  require<T>(actor: Actor, collection: string, recordId: string): T {
    const value = this.repository.get<T>(actor.tenantId, collection, recordId);
    if (!value) throw new NotFoundException('Registro não encontrado.');
    return value;
  }
  notify(actor: Actor, userId: string, title: string, message: string, key = id()): void {
    const notificationId = createHash('sha256').update(`${userId}:${key}`).digest('hex');
    if (this.repository.get(actor.tenantId, 'notifications', notificationId)) return;
    const notification: Notification = {
      id: notificationId,
      userId,
      title,
      message,
      key,
      read: false,
      createdAt: timestamp(),
    };
    this.repository.put(actor.tenantId, 'notifications', notification.id, notification);
  }
  notifyAdmins(actor: Actor, title: string, message: string, key?: string): void {
    for (const admin of this.repository
      .list<Actor>(actor.tenantId, 'customers')
      .filter((u) => u.role === 'admin'))
      this.notify(actor, admin.id, title, message, key);
  }
}
