import 'reflect-metadata';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RateLimiter} from '../dist/core/application/rate-limiter.js';

test('throttling separates identities, expires windows and rejects excess',()=>{const limiter=new RateLimiter();assert.equal(limiter.allow('a',2,100),true);assert.equal(limiter.allow('a',2,101),true);assert.equal(limiter.allow('a',2,102),false);assert.equal(limiter.allow('b',2,102),true);assert.equal(limiter.allow('a',2,60100),true);});
test('backup restores database plus media and refuses corruption or overwrite',async()=>{
 const {mkdtemp,mkdir,writeFile,readFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {resolve}=await import('node:path');const {DatabaseSync}=await import('node:sqlite');const {backupStore,restoreStore}=await import('../scripts/backup.mjs');
 const root=await mkdtemp(resolve(tmpdir(),'compasso-backup-')),media=resolve(root,'media');await mkdir(media);const id='11111111-1111-4111-8111-111111111111';await writeFile(resolve(media,id),'fixture media');
 const db=new DatabaseSync(resolve(root,'source.sqlite'));db.exec('CREATE TABLE documents(tenant_id TEXT, collection TEXT, id TEXT,payload TEXT)');db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run('system','media',id,JSON.stringify({tenantId:'fake',size:13}));db.close();
 await backupStore(resolve(root,'source.sqlite'),media,resolve(root,'snapshot'));const restored=await restoreStore(resolve(root,'snapshot'),resolve(root,'restored'));assert.equal(await readFile(resolve(restored.media,id),'utf8'),'fixture media');await assert.rejects(restoreStore(resolve(root,'snapshot'),resolve(root,'restored')));
 await writeFile(resolve(root,'snapshot','media',id),'tampered');await assert.rejects(restoreStore(resolve(root,'snapshot'),resolve(root,'corrupt')),/Checksum/);
});

