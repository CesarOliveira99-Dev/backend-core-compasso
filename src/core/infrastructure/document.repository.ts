import { Injectable } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DocumentQuery, Repository } from '../domain/document-repository.js';
export { REPOSITORY } from '../domain/document-repository.js';
@Injectable()
export class DocumentRepository implements Repository {
  private readonly db: DatabaseSync;
  constructor() {
    const path = process.env.DATABASE_PATH || resolve('.data/compasso.sqlite');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents (tenant_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(tenant_id, collection, id));',
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS documents_by_customer ON documents(tenant_id, collection, json_extract(payload, '$.customerId')); CREATE INDEX IF NOT EXISTS documents_by_user ON documents(tenant_id, collection, json_extract(payload, '$.userId'));",
    );
    for (const field of ['identityId', 'professionalId']) this.db.exec(`CREATE INDEX IF NOT EXISTS documents_by_${field} ON documents(tenant_id, collection, json_extract(payload, '$.${field}'))`);
  }
  cleanupExpired() {
    this.db.prepare("DELETE FROM documents WHERE tenant_id IN ('system','__compasso_payments__') AND collection IN ('google_challenges','google_enrollments','sessions','registration_keys','account_tickets','team_invites','oauth_states') AND json_extract(payload,'$.expiresAt') <= ?").run(Date.now());
  }
  healthy() { return this.db.prepare('SELECT 1 AS ok').get()?.ok===1; }
  list<T>(tenantId: string, collection: string, query: DocumentQuery = {}): T[] {
    let sql = 'SELECT payload FROM documents WHERE tenant_id=? AND collection=?';
    const parameters = [tenantId, collection];
    if (query.customerId) {
      sql += " AND json_extract(payload, '$.customerId')=?";
      parameters.push(query.customerId);
    }
    if (query.userId) {
      sql += " AND json_extract(payload, '$.userId')=?";
      parameters.push(query.userId);
    }
    for (const field of ['identityId', 'professionalId'] as const) {
      if (query[field]) { sql += ` AND json_extract(payload, '$.${field}')=?`; parameters.push(query[field]!); }
    }
    return this.db
      .prepare(sql)
      .all(...parameters)
      .map((row) => JSON.parse(String(row.payload)) as T);
  }
  get<T>(tenantId: string, collection: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT payload FROM documents WHERE tenant_id=? AND collection=? AND id=?')
      .get(tenantId, collection, id);
    return row ? (JSON.parse(String(row.payload)) as T) : undefined;
  }
  put<T>(tenantId: string, collection: string, id: string, value: T): T {
    this.db
      .prepare(
        'INSERT INTO documents VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, collection, id) DO UPDATE SET payload=excluded.payload',
      )
      .run(tenantId, collection, id, JSON.stringify(value));
    return value;
  }
  remove(tenantId: string, collection: string, id: string): void {
    this.db
      .prepare('DELETE FROM documents WHERE tenant_id=? AND collection=? AND id=?')
      .run(tenantId, collection, id);
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
