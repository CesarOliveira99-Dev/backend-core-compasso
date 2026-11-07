export interface Feedback {
  published?: boolean;
  id: string;
  customerId: string;
  customerName: string;
  appointmentId: string;
  rating: number;
  comment: string;
  reply: string;
  createdAt: string;
}
