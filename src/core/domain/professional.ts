export interface Professional {
  userId?: string;
  breaks?: { start: string; end: string; date?: string }[];
  daysOff?: string[];
  id: string;
  name: string;
  active: boolean;
  serviceIds: string[];
  weeklyHours?: { day: number; openingHour: number; closingHour: number }[];
  openingHour: number;
  closingHour: number;
  workDays: number[];
}
