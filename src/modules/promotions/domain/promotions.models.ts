export interface Discount {
  id: string;
  name: string;
  code?: string;
  percent: number;
  itemIds: string[];
  kinds: string[];
  weekdays: number[];
  startsAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  active: boolean;
}
