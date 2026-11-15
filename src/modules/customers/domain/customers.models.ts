import type { Actor } from '../../../core/domain/models.js';
export interface Customer extends Actor {
  internal?: boolean;
  systemContact?: boolean;
  passwordHash: string;
  addresses: Address[];
}
export interface Address {
  id: string;
  label: string;
  street: string;
  number: string;
  city: string;
  postalCode: string;
  isDefault: boolean;
}
