export interface Loyalty {
  id: string;
  customerId: string;
  itemId: string;
  itemName: string;
  nextDate: string;
  note: string;
  status: 'active' | 'reminded';
  createdAt: string;
}
