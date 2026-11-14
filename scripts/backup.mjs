import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, copyFile, readFile, writeFile, constants } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
async function digest(file) { const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex'); }
function inspect(path){const db=new DatabaseSync(path,{readOnly:true});try{if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Banco inconsistente.');return db.prepare("SELECT id FROM documents WHERE tenant_id='system' AND collection='media'").all().map(row=>String(row.id));}finally{db.close();}}
export async function backupStore(database, media, destination){
 const target=resolve(destination),source=resolve(database),mediaSource=resolve(media);
 if(target===dirname(source)||target===mediaSource||target.startsWith(mediaSource+'/')||target.startsWith(mediaSource+'\\'))throw new Error('Destino inválido. Use uma pasta nova fora da mídia.');
 await mkdir(dirname(target),{recursive:true});await mkdir(target);await mkdir(resolve(target,'media'));
 const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,resolve(target,'database.sqlite'));}finally{db.close();}
 const files=['database.sqlite'];
 for(const id of inspect(resolve(target,'database.sqlite'))){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('ID de mídia inválido.');await copyFile(resolve(mediaSource,id),resolve(target,'media',id),constants.COPYFILE_EXCL);files.push(`media/${id}`);}
 const manifest={version:1,createdAt:new Date().toISOString(),files:await Promise.all(files.map(async path=>({path,sha256:await digest(resolve(target,path))})))};
 await writeFile(resolve(target,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});return manifest;
}
export async function restoreStore(source,destination){
 const root=resolve(source),target=resolve(destination),manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
 if(manifest.version!==1 || !Array.isArray(manifest.files))throw new Error('Manifesto inválido.');
 const paths=new Set();for(const file of manifest.files){if(!/^(database\.sqlite|media\/[a-f0-9-]{36})$/.test(file.path)||paths.has(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Arquivo inválido no manifesto.');paths.add(file.path);if(await digest(resolve(root,file.path))!==file.sha256)throw new Error('Checksum divergente. Restauração recusada.');}
 if(!paths.has('database.sqlite'))throw new Error('Backup sem banco.');
 for(const id of inspect(resolve(root,'database.sqlite')))if(!paths.has(`media/${id}`))throw new Error('Backup sem mídia referenciada.');
 await mkdir(dirname(target),{recursive:true});await mkdir(target);await mkdir(resolve(target,'media'));
 for(const file of manifest.files)await copyFile(resolve(root,file.path),resolve(target,file.path),constants.COPYFILE_EXCL);
 inspect(resolve(target,'database.sqlite'));return {database:resolve(target,'database.sqlite'),media:resolve(target,'media')};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [operation,target,destination]=process.argv.slice(2);
 try {if(operation==='backup'&&target){const database=process.env.DATABASE_PATH;if(!database||database===':memory:')throw new Error('Configure DATABASE_PATH para o banco a copiar.');const result=await backupStore(database,process.env.MEDIA_PATH||resolve(dirname(database),'media'),target);console.log(JSON.stringify({ok:true,files:result.files.length}));}
 else if(operation==='restore'&&target&&destination)console.log(JSON.stringify(await restoreStore(target,destination)));
 else throw new Error('Uso: node scripts/backup.mjs backup PASTA_NOVA | restore BACKUP DESTINO_NOVO');}
 catch(error){console.error(error.message);process.exitCode=1;}
}
