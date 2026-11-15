import {Controller,Get,ServiceUnavailableException} from '@nestjs/common';
import {statfsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {Context} from './core/application/context.js';
import {Public} from './modules/identity/application/identity.schemas.js';
@Controller('health')
export class HealthController {
 constructor(private readonly context:Context){}
 @Public() @Get() health(){try{
   if(this.context.repository.healthy && !this.context.repository.healthy())throw new Error('database');
   const path=process.env.DATABASE_PATH;const disk=statfsSync(path&&path!==':memory:'?dirname(resolve(path)):process.cwd());
   if(disk.bavail*disk.bsize<128*1024*1024)throw new Error('storage');
   return {status:'ok',database:'ok',storage:'ok'};
 }catch{throw new ServiceUnavailableException('Verificação de saúde indisponível.');}}
}
