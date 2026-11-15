import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { backupStore, restoreStore } from '../scripts/backup.mjs';
import { uploadSnapshot, downloadSnapshot, runBackup, r2Config } from '../scripts/backup-r2.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'compasso-r2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = join(root, 'source.sqlite'), media = join(root, 'source-media');
  await mkdir(media);
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE documents (tenant_id TEXT, collection TEXT, id TEXT, payload TEXT)');
  const mediaId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  db.prepare('INSERT INTO documents VALUES (?,?,?,?)').run('system', 'media', mediaId, '{}');
  db.prepare('INSERT INTO documents VALUES (?,?,?,?)').run('test', 'customers', 'one', '{"name":"Fixture"}');
  db.close();
  await writeFile(join(media, mediaId), 'fixture-media');
  const objects = new Map(), commands = [];
  const client = { async send(command) {
    commands.push(command);
    const { Key, Body } = command.input;
    if (command.constructor.name === 'PutObjectCommand') {
      const chunks = []; for await (const chunk of Buffer.isBuffer(Body) ? [Body] : Body) chunks.push(chunk);
      objects.set(Key, Buffer.concat(chunks)); return {};
    }
    if (!objects.has(Key)) throw new Error('Missing object');
    return { Body: Readable.from([objects.get(Key)]) };
  } };
  return { root, database, media, mediaId, client, objects, commands };
}

test('R2 backup publishes manifest last, verifies reads and restores DB plus media', async t => {
  const f = await fixture(t), snapshot = join(f.root, 'snapshot');
  await backupStore(f.database, f.media, snapshot);
  const result = await uploadSnapshot(f.client, 'bucket', snapshot);
  const puts = f.commands.filter(command => command.constructor.name === 'PutObjectCommand');
  assert.ok(puts.at(-1).input.Key.endsWith('/manifest.json'));
  assert.equal(f.commands.filter(command => command.constructor.name === 'GetObjectCommand').length, puts.length);
  const download = join(f.root, 'download');
  await downloadSnapshot(f.client, 'bucket', result.prefix, download);
  const restored = await restoreStore(download, join(f.root, 'restored'));
  const db = new DatabaseSync(restored.database, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS total FROM documents').get().total, 2); db.close();
  assert.equal(await readFile(join(restored.media, f.mediaId), 'utf8'), 'fixture-media');
  await assert.rejects(() => downloadSnapshot(f.client, 'bucket', result.prefix, download));
});

test('failed upload preserves local snapshot and does not publish a completed manifest; retry recovers and daily run skips', async t => {
  const f = await fixture(t);
  const failed = { async send() { throw new Error('provider failure'); } };
  await assert.rejects(() => runBackup(failed, 'bucket', f.database, f.media));
  assert.ok(await readFile(join(f.root, '.compasso-r2/pending/manifest.json')));
  assert.equal(f.objects.size, 0);
  await runBackup(f.client, 'bucket', f.database, f.media);
  const before = f.commands.length;
  assert.deepEqual(await runBackup(f.client, 'bucket', f.database, f.media), { skipped: true });
  assert.equal(f.commands.length, before);
});

test('corrupt remote bytes are rejected and no completion manifest is published', async t => {
  const f = await fixture(t), snapshot = join(f.root, 'snapshot');
  await backupStore(f.database, f.media, snapshot);
  const corrupt = { async send(command) {
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([Buffer.from('corrupt')]) };
    return f.client.send(command);
  } };
  await assert.rejects(() => uploadSnapshot(corrupt, 'bucket', snapshot), /divergente/);
  assert.ok(![...f.objects.keys()].some(key => key.endsWith('manifest.json')));
});

test('rejects foreign endpoints and traversal in restore manifest', async t => {
  assert.throws(() => r2Config({ R2_ENDPOINT: 'https://evil.test', R2_BUCKET: 'bucket', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret' }));
  const f = await fixture(t), prefix = 'compasso/2026-11-15T12-00-00Z-aaaaaaaaaaaaaaaa';
  f.objects.set(prefix + '/manifest.json', Buffer.from(JSON.stringify({ version: 1, files: [{ path: '../outside', sha256: 'a'.repeat(64), bytes: 1 }] })));
  await assert.rejects(() => downloadSnapshot(f.client, 'bucket', prefix, join(f.root, 'download')), /inválido/);
});

