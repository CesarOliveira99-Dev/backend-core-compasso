import {
  BadRequestException,
  HttpException,
  Res,
  Controller,
  Get,
  Header,
  Injectable,
  Module,
  Param,
  Post,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { mkdirSync, createReadStream, writeFileSync, unlinkSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Context, id } from '../../core/application/context.js';
import type { Actor } from '../../core/domain/models.js';
import type { MediaAsset } from '../settings/domain/settings.models.js';
import { Public, type AuthRequest } from '../identity/application/identity.schemas.js';

interface StoredMedia {
  id?: string;
  createdAt?: number;
  tenantId: string;
  mime: string;
  size: number;
}
interface Upload {
  buffer: Buffer;
  mimetype: string;
}
const maximumBytes = 12 * 1024 * 1024;
function mediaType(file: Upload): 'image' | 'video' {
  const b = file.buffer;
  if (
    file.mimetype === 'image/png' &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image';
  if (file.mimetype === 'image/jpeg' && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return 'image';
  if (
    file.mimetype === 'image/webp' &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image';
  if (file.mimetype === 'video/mp4' && b.toString('ascii', 4, 8) === 'ftyp') return 'video';
  if (file.mimetype === 'video/webm' && b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return 'video';
  throw new BadRequestException('Use fotos JPG, PNG ou WebP, ou vídeos MP4/WebM válidos.');
}
@Injectable()
export class MediaService {
  constructor(private readonly context: Context) {}
  private directory() {
    return resolve(
      process.env.MEDIA_PATH ||
        resolve(dirname(process.env.DATABASE_PATH || '.data/compasso.sqlite'), 'media'),
    );
  }
  upload(actor: Actor, file?: Upload): MediaAsset {
    this.context.admin(actor);
    if (!file?.buffer?.length || file.buffer.length > maximumBytes)
      throw new BadRequestException('Envie um arquivo de até 12 MB.');
    const type = mediaType(file);
    if (type === 'image' && file.buffer.length > 5 * 1024 * 1024)
      throw new BadRequestException('Fotos devem ter até 5 MB.');
    return this.context.repository.transaction(() => {
      this.releaseUnused(actor,[],true);
      const all=this.context.repository.list<StoredMedia>('system','media');
      mkdirSync(this.directory(),{recursive:true});
      const disk=statfsSync(this.directory());
      const remaining=disk.bavail*disk.bsize;
      const globalLimit=Number(process.env.MEDIA_TOTAL_LIMIT_MB || 10240)*1024*1024;
      if(remaining-file.buffer.length<128*1024*1024 || all.reduce((sum,item)=>sum+item.size,0)+file.buffer.length>globalLimit) throw new BadRequestException('Armazenamento temporariamente indisponível. Contate o suporte.');
      const total = this.context.repository
        .list<StoredMedia>('system', 'media')
        .filter((record) => record.tenantId === actor.tenantId)
        .reduce((sum, record) => sum + record.size, 0);
      if (total + file.buffer.length > 200 * 1024 * 1024)
        throw new BadRequestException('O armazenamento da loja atingiu 200 MB.');
      const mediaId = id();
      mkdirSync(this.directory(), { recursive: true });
      const path = resolve(this.directory(), mediaId);
      writeFileSync(path, file.buffer, { flag: 'wx' });
      try {
        this.context.repository.put('system', 'media', mediaId, {
          id:mediaId,createdAt:Date.now(),
          tenantId: actor.tenantId,
          mime: file.mimetype,
          size: file.buffer.length,
        });
      } catch (error) {
        unlinkSync(path);
        throw error;
      }
      return { url: `/api/media/${mediaId}`, type, alt: '' };
    });
  }
  validate(actor: Actor, assets: MediaAsset[] = []) {
    for (const asset of assets) {
      const mediaId = asset.url.split('/').pop()!;
      const record = this.context.repository.get<StoredMedia>('system', 'media', mediaId);
      if (
        !record ||
        record.tenantId !== actor.tenantId ||
        !record.mime.startsWith(`${asset.type}/`)
      )
        throw new BadRequestException('Selecione arquivos enviados por esta loja.');
    }
  }
  releaseUnused(actor:Actor, candidates:MediaAsset[]=[], includeOrphans=false) {
    this.context.admin(actor);
    const references=new Set<string>();
    for(const document of [...this.context.repository.list<{media?:MediaAsset[]}>(actor.tenantId,'settings'),...this.context.repository.list<{media?:MediaAsset[]}>(actor.tenantId,'catalog')])for(const asset of document.media || []) references.add(asset.url);
    const ids=candidates.map(asset=>asset.url.split('/').pop()!);
    if(includeOrphans)for(const record of this.context.repository.list<StoredMedia>('system','media'))if(record.id && record.tenantId===actor.tenantId && record.createdAt && record.createdAt<Date.now()-86400000)ids.push(record.id);
    for(const mediaId of new Set(ids)) {
      if(!/^[a-f0-9-]{36}$/.test(mediaId) || references.has(`/api/media/${mediaId}`))continue;
      const record=this.context.repository.get<StoredMedia>('system','media',mediaId);
      if(!record || record.tenantId!==actor.tenantId)continue;
      try{unlinkSync(resolve(this.directory(),mediaId));}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){console.warn('media_cleanup_failed');continue;}}
      this.context.repository.remove('system','media',mediaId);
    }
  }
  read(mediaId: string,range?:string,response?:{status:(status:number)=>void;setHeader:(key:string,value:string)=>void}) {
    if (!/^[a-f0-9-]{36}$/.test(mediaId)) throw new BadRequestException('Arquivo inválido.');
    const record = this.context.repository.get<StoredMedia>('system', 'media', mediaId);
    if (!record) throw new BadRequestException('Arquivo não encontrado.');
    response?.setHeader('Accept-Ranges','bytes');
    let start=0,end=record.size-1;
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match || (!match[1]&&!match[2])){response?.setHeader('Content-Range',`bytes */${record.size}`);throw new HttpException('Intervalo inválido.',416);}
      if(!match[1])start=Math.max(0,record.size-Number(match[2]));
      else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start<0||start>=record.size){response?.setHeader('Content-Range',`bytes */${record.size}`);throw new HttpException('Intervalo inválido.',416);}
      response?.status(206);response?.setHeader('Content-Range',`bytes ${start}-${end}/${record.size}`);
    }
    return new StreamableFile(createReadStream(resolve(this.directory(),mediaId),{start,end}),{type:record.mime,length:end-start+1,disposition:'inline'});
  }
}
@Controller('media')
class MediaController {
  constructor(private readonly media: MediaService) {}
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: maximumBytes, files: 1 } }))
  upload(@Req() request: AuthRequest, @UploadedFile() file?: Upload) {
    return this.media.upload(request.actor, file);
  }
  @Public() @Get(':id') @Header('X-Content-Type-Options', 'nosniff') read(
    @Param('id') mediaId: string,
    @Req() request:AuthRequest,
    @Res({passthrough:true}) response:{status:(status:number)=>void;setHeader:(key:string,value:string)=>void},
  ) {
    return this.media.read(mediaId,request.headers.range,response);
  }
}
@Module({ providers: [MediaService], controllers: [MediaController], exports: [MediaService] })
export class MediaModule {}
