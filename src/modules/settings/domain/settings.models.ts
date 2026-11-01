export interface Settings {
  name: string;
  businessName: string;
  slug: string;
  timezone: string;
  completionMode: 'manual' | 'automatic';
  payOnAppointment: boolean;
  payOnDelivery: boolean;
  bankAccount: string;
  pixKey: string;
  openingHour: number;
  closingHour: number;
  workDays: number[];
}
