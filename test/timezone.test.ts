import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema } from '../dist/modules/settings/application/settings.schemas.js';
import { localTimestamp } from '../dist/modules/appointments/domain/availability.js';
import { emailQuota } from '../dist/core/application/email-quota.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
process.env.DATABASE_PATH = ':memory:';
test('timezone accepts named regions and rejects invalid input', () => {
  const field = settingsSchema.shape.timezone;
  assert.equal(field.parse('America/Campo_Grande'), 'America/Campo_Grande');
  assert.equal(field.parse('America/Sao_Paulo'), 'America/Sao_Paulo');
  assert.equal(field.safeParse('invalid/zone').success, false);
  assert.equal(field.safeParse('-04:00').success, false);
  assert.throws(() => localTimestamp('2026-03-08', 150, 'America/New_York'), /inexistente ou ambíguo/);
  assert.throws(() => localTimestamp('2026-11-01', 90, 'America/New_York'), /inexistente ou ambíguo/);
});
test('availability and daily email windows use the workspace zone', () => {
  assert.equal(localTimestamp('2026-11-15', 540, 'America/Campo_Grande'), Date.parse('2026-11-15T13:00:00Z'));
  const repo = new DocumentRepository();
  repo.put('ms', 'settings', 'business', { timezone: 'America/Campo_Grande' });
  const now = Date.parse('2026-11-15T03:30:00Z');
  assert.equal(emailQuota(repo, 'ms', now).day, '2026-11-14');
  assert.equal(emailQuota(repo, 'legacy', now).day, '2026-11-15');
});

