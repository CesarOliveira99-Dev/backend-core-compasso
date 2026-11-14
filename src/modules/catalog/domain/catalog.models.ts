import type { MediaAsset } from '../../settings/domain/settings.models.js';
export interface CatalogItem {
  media?: MediaAsset[];
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
