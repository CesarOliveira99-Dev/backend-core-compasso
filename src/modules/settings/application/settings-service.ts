import { Injectable } from '@nestjs/common';
import { Context, parse } from '../../../core/application/context.js';
import type { Actor, Customer } from '../../../core/domain/models.js';
import { settingsSchema } from './settings.schemas.js';
@Injectable()
export class SettingsService {
  constructor(private readonly context: Context) {}
  get(actor: Actor) {
    const settings = this.context.settings(actor);
    const { bankAccount, pixKey, ...publicSettings } = settings;
    return {
      ...(actor.role === 'admin' ? settings : publicSettings),
      onlinePaymentsEnabled: false,
      whatsappEnabled: false,
    };
  }
  update(actor: Actor, body: unknown) {
    this.context.admin(actor);
    const input = parse(settingsSchema, body);
    const settings = { ...this.context.settings(actor), ...input };
    return this.context.repository.transaction(() => {
      this.context.repository.put(actor.tenantId, 'settings', 'business', settings);
      const customer = this.context.require<Customer>(actor, 'customers', actor.id);
      this.context.repository.put(actor.tenantId, 'customers', actor.id, {
        ...customer,
        name: input.name,
      });
      return { ...settings, onlinePaymentsEnabled: false, whatsappEnabled: false };
    });
  }
}
