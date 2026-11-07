export type Role = 'admin' | 'customer' | 'employee';
export interface Actor {
  identityId?: string;
  professionalId?: string;
  active?: boolean;
  emailVerified?: boolean;
  id: string;
  tenantId: string;
  role: Role;
  name: string;
  email: string;
  phone: string;
}
export type {
  Appointment,
  AppointmentStatus,
} from '../../modules/appointments/domain/appointments.models.js';
export type { CatalogItem } from '../../modules/catalog/domain/catalog.models.js';
export type { Order } from '../../modules/checkout/domain/checkout.models.js';
export type { Address, Customer } from '../../modules/customers/domain/customers.models.js';
export type { Feedback } from '../../modules/feedback/domain/feedback.models.js';
export type { Loyalty } from '../../modules/loyalty/domain/loyalty.models.js';
export type { Notification } from '../../modules/notifications/domain/notifications.models.js';
export type { Discount } from '../../modules/promotions/domain/promotions.models.js';
export type { Settings } from '../../modules/settings/domain/settings.models.js';
export type { Triage } from '../../modules/triage/domain/triage.models.js';
