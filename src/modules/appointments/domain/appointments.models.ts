export type AppointmentStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled';
export interface Appointment {
  id: string;
  customerId: string;
  customerName: string;
  itemId: string;
  itemName: string;
  startsAt: string;
  endsAt: string;
  priceCents: number;
  status: AppointmentStatus;
  paymentStatus: 'pending' | 'paid';
  notes: string;
  orderId?: string;
  completedAt?: string;
  paidAt?: string;
  createdAt: string;
}
