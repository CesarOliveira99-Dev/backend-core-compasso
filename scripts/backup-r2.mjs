import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm, stat, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupStore, restoreStore } from './backup.mjs';

export function r2Config(env = process.env) {
  const endpoint = new URL(env.R2_ENDPOINT || 'https://invalid');
  if (endpoint.protocol !== 'https:' || !/^[a-f0-9]{32}(\.(eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.port || endpoint.pathname !== '/')
    throw new Error('R2_ENDPOINT inválido.');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET || '') || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY)
    throw new Error('Configuração R2 incompleta.');
  return { bucket: env.R2_BUCKET, endpoint: endpoint.origin, region: 'auto',
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } };
}
const send = (client, command) => client.send(command, { abortSignal: AbortSignal.timeout(300000) });
const hash = () => createHash('sha256');
const filePath = /^(database\.sqlite|media\/[a-f0-9-]{36})$/;
const validPrefix = value => /^compasso\/\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{16}$/.test(value);
async function verify(client, bucket, key, expected) {
  const response = await send(client, new GetObjectCommand({ Bucket: bucket, Key: key }));
  const digest = hash();
  let bytes = 0;
  for await (const chunk of response.Body) {
    bytes += chunk.length;
    if (bytes > expected.bytes) { response.Body.destroy(); throw new Error('Tamanho remoto divergente.'); }
    digest.update(chunk);
  }
  if (bytes !== expected.bytes || digest.digest('hex') !== expected.sha256) throw new Error('Checksum remoto divergente.');
}

/** Publish manifest last: incomplete uploads cannot be mistaken for restorable snapshots. */
export async function uploadSnapshot(client, bucket, root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const files = [];
  for (const file of manifest.files) {
    if (!filePath.test(file.path)) throw new Error('Caminho de backup inválido.');
    files.push({ ...file, bytes: (await stat(resolve(root, file.path))).size });
  }
  const prefix = `compasso/${manifest.createdAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')}-${files[0].sha256.slice(0, 16)}`;
  for (const file of files) {
    await send(client, new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/${file.path}`, Body: createReadStream(resolve(root, file.path)), ContentLength: file.bytes }));
    await verify(client, bucket, `${prefix}/${file.path}`, file);
  }
  const body = Buffer.from(JSON.stringify({ ...manifest, files }));
  await send(client, new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/manifest.json`, Body: body, ContentLength: body.length, ContentType: 'application/json' }));
  await verify(client, bucket, `${prefix}/manifest.json`, { bytes: body.length, sha256: hash().update(body).digest('hex') });
  return { prefix, snapshotAt: Date.parse(manifest.createdAt), files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}

export async function downloadSnapshot(client, bucket, prefix, destination) {
  if (!validPrefix(prefix)) throw new Error('Prefixo de backup inválido.');
  const response = await send(client, new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/manifest.json` }));
  const chunks = []; let size = 0;
  for await (const chunk of response.Body) { size += chunk.length; if (size > 2 * 1024 * 1024) { response.Body.destroy(); throw new Error('Manifesto excede o limite.'); } chunks.push(chunk); }
  const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const paths = new Set();
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000) throw new Error('Manifesto inválido.');
  for (const file of manifest.files) {
    if (!filePath.test(file.path) || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 1024 ** 3)
      throw new Error('Arquivo inválido no manifesto.');
    paths.add(file.path);
  }
  if (!paths.has('database.sqlite')) throw new Error('Backup sem banco.');
  await mkdir(destination); await mkdir(resolve(destination, 'media'));
  for (const file of manifest.files) {
    const result = await send(client, new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/${file.path}` }));
    let bytes = 0; const digest = hash();
    await pipeline(result.Body, new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length; digest.update(chunk);
      done(bytes > file.bytes ? new Error('Arquivo excede o tamanho esperado.') : null, chunk);
    } }), createWriteStream(resolve(destination, file.path), { flags: 'wx' }));
    if (bytes !== file.bytes || digest.digest('hex') !== file.sha256) throw new Error('Checksum divergente.');
  }
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
}

export async function runBackup(client, bucket, database, media, now = Date.now()) {
  const root = resolve(dirname(database), '.compasso-r2');
  const pending = resolve(root, 'pending'), statePath = resolve(root, 'state.json');
  await mkdir(root, { recursive: true });
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state?.snapshotAt <= now && state.snapshotAt > now - 24 * 3600000) return { skipped: true };
  const lock = resolve(root, 'lock');
  try { await mkdir(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (now - (await stat(lock)).mtimeMs < 2 * 3600000) return { skipped: true };
    await rm(lock, { recursive: true }); await mkdir(lock);
  }
  try {
    try { await readFile(resolve(pending, 'manifest.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await rm(pending, { recursive: true, force: true });
      await backupStore(database, media, pending);
    }
    const result = await uploadSnapshot(client, bucket, pending);
    await writeFile(statePath + '.tmp', JSON.stringify({ lastSuccessAt: now, ...result }));
    await rename(statePath + '.tmp', statePath);
    await rm(pending, { recursive: true });
    console.log(JSON.stringify({ event: 'backup_r2_success', ...result }));
    return result;
  } finally { await rm(lock, { recursive: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let client;
  try {
    const config = r2Config(); client = new S3Client({ ...config, maxAttempts: 3, requestHandler: { connectionTimeout: 10000, requestTimeout: 120000 } });
    const database = process.env.DATABASE_PATH;
    if (!database || database === ':memory:') throw new Error('Banco persistente não configurado.');
    if (process.argv[2] === 'restore') {
      const [prefix, destination] = process.argv.slice(3);
      if (!destination) throw new Error('Informe um destino novo.');
      const download = resolve(destination) + '.download';
      await downloadSnapshot(client, config.bucket, prefix, download);
      await restoreStore(download, resolve(destination));
      console.log(JSON.stringify({ event: 'backup_r2_restored', destination: resolve(destination) }));
    } else await runBackup(client, config.bucket, database, process.env.MEDIA_PATH || resolve(dirname(database), 'media'));
  } catch (error) {
    // Provider errors can contain request headers or signed URLs. Keep logs bounded and credential-free.
    const safeCode = value => /^[A-Za-z0-9_]{1,64}$/.test(value || '') ? value : undefined;
    console.error(JSON.stringify({ event: 'backup_r2_failed', code: safeCode(error?.name) || 'Error',
      systemCode: safeCode(error?.code), httpStatus: Number.isInteger(error?.$metadata?.httpStatusCode) ? error.$metadata.httpStatusCode : undefined }));
    process.exitCode = 1;
  } finally { client?.destroy(); }
}

