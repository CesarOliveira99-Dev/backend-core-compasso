export interface DocumentQuery {
  customerId?: string;
  userId?: string;
}
export interface Repository {
  list<T>(tenantId: string, collection: string, query?: DocumentQuery): T[];
  get<T>(tenantId: string, collection: string, id: string): T | undefined;
  put<T>(tenantId: string, collection: string, id: string, value: T): T;
  remove(tenantId: string, collection: string, id: string): void;
  transaction<T>(action: () => T): T;
}
export const REPOSITORY = Symbol('REPOSITORY');
