import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Context, parse } from '../../../core/application/context.js';
import type {Actor,Customer} from '../../../core/domain/models.js';
import {hashPassword} from './identity.schemas.js';
import {tokenHash} from './memberships.js';
export interface MailSender { configured(): boolean; send(email:string, subject:string, link:string, key:string):Promise<void>; }
export class TransactionalMail implements MailSender {
  configured() { return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM && process.env.APP_URL); }
  async send(email:string, subject:string, link:string, key:string) {
    const response = await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({from:process.env.MAIL_FROM,to:[email],subject,text:`${subject}\n\nAbra o link para continuar: ${link}\n\nSe você não solicitou, ignore esta mensagem.`})});
    if (!response.ok) throw new ServiceUnavailableException('Não foi possível enviar o e-mail. Tente novamente.');
  }
}
interface Ticket { purpose:'password'|'verify'; accounts:{tenantId:string;id:string;version:number}[]; expiresAt:number; }
export class AccountRecovery {
  constructor(private readonly context:Context,private readonly mail:MailSender = new TransactionalMail()) {}
  async request(purpose:'password'|'verify', body:unknown, actor?:Actor) {
    const {email} = parse(z.object({email:z.string().email().transform(value=>value.toLowerCase())}),body);
    if (purpose === 'verify' && (!actor || actor.email !== email)) throw new UnauthorizedException();
    if (!this.mail.configured()) throw new ServiceUnavailableException('O envio de e-mails ainda está sendo configurado.');
    const origin=new URL(process.env.APP_URL!);
    if (origin.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new ServiceUnavailableException();
    const accounts = this.context.repository.list<{tenantId:string}>('system','stores').flatMap(store => this.context.repository.list<Customer>(store.tenantId,'customers').filter(user=>user.email===email).map(user=>({tenantId:store.tenantId,id:user.id,version:this.context.repository.get<{version:number}>(store.tenantId,'credential_epochs',user.id)?.version || 0})));
    if (accounts.length) {
      const token=randomBytes(32).toString('hex'), key=tokenHash(token);
      this.context.repository.put('system','account_tickets',key,{purpose,accounts,expiresAt:Date.now()+ (purpose==='password'?15*60000:86400000)} satisfies Ticket);
      try { await this.mail.send(email,purpose==='password'?'Redefinir senha do Compasso':'Confirmar e-mail do Compasso',`${origin.origin}/conta#${purpose}:${token}`,key); }
      catch(error) { this.context.repository.remove('system','account_tickets',key);throw error; }
    }
    return {message:'Se o endereço tiver cadastro, você receberá um e-mail com as instruções.'};
  }
  complete(body:unknown) {
    const input=parse(z.object({token:z.string().regex(/^[a-f0-9]{64}$/),password:z.string().min(8).max(128).optional(),confirmPassword:z.string().max(128).optional()}),body);
    return this.context.repository.transaction(()=>{
      const key=tokenHash(input.token),ticket=this.context.repository.get<Ticket>('system','account_tickets',key);
      if (!ticket || ticket.expiresAt <= Date.now()) throw new BadRequestException('Link inválido, expirado ou já utilizado.');
      if (ticket.purpose==='password' && (!input.password || input.password!==input.confirmPassword)) throw new BadRequestException('As senhas não coincidem.');
      if(ticket.purpose==='password' && ticket.accounts.some(account => (this.context.repository.get<{version:number}>(account.tenantId,'credential_epochs',account.id)?.version || 0) !== account.version)) throw new BadRequestException('Link substituído por uma redefinição mais recente.');
      const passwordHash=ticket.purpose==='password'?hashPassword(input.password!):undefined;
      for(const account of ticket.accounts) {
        const user=this.context.repository.get<Customer>(account.tenantId,'customers',account.id);
        if(user) this.context.repository.put(account.tenantId,'customers',account.id,{...user,emailVerified:true,...(passwordHash?{passwordHash}:{})});
      }
      if(passwordHash) for(const account of ticket.accounts) this.context.repository.put(account.tenantId,'credential_epochs',account.id,{version:account.version+1});
      this.context.repository.remove('system','account_tickets',key);
      return {ok:true};
    });
  }
}
