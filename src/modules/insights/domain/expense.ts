export interface Expense {
  id: string;
  description: string;
  category: 'supplies' | 'rent' | 'utilities' | 'other';
  amountCents: number;
  paidOn: string;
  createdAt: string;
}
