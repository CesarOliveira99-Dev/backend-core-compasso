export interface BusinessAddress {
  postalCode: string;
  street: string;
  number: string;
  district: string;
  city: string;
  state: string;
  complement: string;
}
export interface MediaAsset {
  category?: 'workspace' | 'portfolio';
  url: string;
  type: 'image' | 'video';
  alt: string;
}
export interface Settings {
  phone?: string;
  address?: BusinessAddress;
  description?: string;
  media?: MediaAsset[];
  setupComplete?: boolean;
  name: string;
  businessName: string;
  slug: string;
  timezone: string;
  completionMode: 'manual' | 'automatic';
  payOnAppointment: boolean;
  payOnDelivery: boolean;
  bankAccount: string;
  pixKey: string;
  weeklyHours?: { day: number; openingHour: number; closingHour: number }[];
  openingHour: number;
  closingHour: number;
  workDays: number[];
}
