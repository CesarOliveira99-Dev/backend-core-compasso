export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  kind: 'service' | 'product';
  category: string;
  priceCents: number;
  durationMinutes: number;
  requiresTriage: boolean;
  active: boolean;
}
