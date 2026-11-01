import type { Address } from '../../customers/domain/customers.models.js';
export interface Order {
  id: string;
  customerId: string;
  customerName: string;
  items: {
    itemId: string;
    name: string;
    quantity: number;
    kind: string;
    unitPriceCents: number;
    startsAt?: string;
  }[];
  totalCents: number;
  discountCents: number;
  status: 'pending' | 'completed' | 'cancelled';
  paymentStatus: 'pending' | 'paid';
  paymentMethod: 'on_day' | 'online';
  address?: Address;
  seen: boolean;
  createdAt: string;
  completedAt?: string;
  paidAt?: string;
}
