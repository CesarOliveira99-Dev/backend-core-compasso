export interface Triage {
  id: string;
  customerId: string;
  customerName: string;
  appointmentId?: string;
  orderId?: string;
  answers: string;
  status: 'pending' | 'approved' | 'declined';
  decision: string;
  createdAt: string;
}
