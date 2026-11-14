import {BadRequestException,ForbiddenException} from '@nestjs/common';
import {z} from 'zod';
import {Context,id,parse} from '../../core/application/context.js';
import type {Actor,Appointment,Feedback} from '../../core/domain/models.js';
import {verifiedReviews,reviewSummary,recommendationStatus} from '../feedback/domain/reputation.js';
interface Purchase {id:string;tenantId:string;priceCents:number;status:string;url?:string;paymentId?:string;paidAt?:string;}
interface Payment {id:number;collector_id:number;currency_id:string;transaction_amount:number;external_reference:string;live_mode:boolean;status:string;date_approved?:string;}
type ProviderCall=<T>(path:string,token?:string,body?:unknown,key?:string)=>Promise<T>;
const scope='__compasso_payments__';
export function addonPrice(){const value=Number(process.env.COMPASSO_RECOMMENDATION_PRICE_CENTS||0);return Number.isSafeInteger(value)&&value>0?value:0;}
export class RecommendationAddon {
 constructor(private readonly context:Context,private readonly call:ProviderCall){}
 private get repo(){return this.context.repository;}
 status(actor:Actor){this.context.admin(actor);return {priceCents:addonPrice(),days:30,enabled:!!(addonPrice()&&process.env.MP_PLATFORM_ACCESS_TOKEN&&process.env.MP_PLATFORM_USER_ID&&process.env.APP_URL&&process.env.PUBLIC_API_URL&&process.env.MP_WEBHOOK_SECRET),entitlement:this.repo.get(actor.tenantId,'platform_entitlements','recommendation')||null};}
 async purchase(actor:Actor,body:unknown){
  this.context.admin(actor);const {idempotencyKey}=parse(z.object({idempotencyKey:z.string().uuid()}),body);
  if(!this.status(actor).enabled)throw new BadRequestException('A contratação do adicional ainda não está configurada.');
  const summary=reviewSummary(verifiedReviews(this.repo.list<Feedback>(actor.tenantId,'feedback'),this.repo.list<Appointment>(actor.tenantId,'appointments')));
  if(!recommendationStatus(summary).qualified)throw new BadRequestException('A loja precisa de média mínima 4,8 e 10 avaliações verificadas para contratar.');
  const key=`${actor.tenantId}:${idempotencyKey}`;
  let purchase=this.repo.get<Purchase>(scope,'addon_purchases',key);
  if(purchase?.url)return {url:purchase.url};
  if(!purchase){purchase={id:key,tenantId:actor.tenantId,priceCents:addonPrice(),status:'pending'};this.repo.put(scope,'addon_purchases',key,purchase);}
  const app=new URL(process.env.APP_URL!),api=new URL(process.env.PUBLIC_API_URL!);
  if(app.protocol!=='https:'||api.protocol!=='https:')throw new BadRequestException('Configure as URLs HTTPS.');
  const result=await this.call<{init_point:string;sandbox_init_point:string}>('/checkout/preferences',process.env.MP_PLATFORM_ACCESS_TOKEN,{items:[{id:'recommendation-30-days',title:'Adicional Recomendado pelo Compasso — 30 dias',quantity:1,currency_id:'BRL',unit_price:purchase.priceCents/100}],external_reference:`compasso-addon:${key}`,notification_url:`${api.toString().replace(/\/$/,'')}/payments/webhook`,back_urls:{success:app.toString(),failure:app.toString(),pending:app.toString()},auto_return:'approved'},idempotencyKey);
  const url=process.env.MP_SANDBOX==='true'?result.sandbox_init_point:result.init_point;
  this.repo.put(scope,'addon_purchases',key,{...purchase,url});return {url};
 }
 async webhook(dataId:string){
  const payment=await this.call<Payment>(`/v1/payments/${encodeURIComponent(dataId)}`,process.env.MP_PLATFORM_ACCESS_TOKEN);
  if(String(payment.id)!==dataId || String(payment.collector_id)!==process.env.MP_PLATFORM_USER_ID || payment.currency_id!=='BRL' || payment.live_mode!==(process.env.MP_SANDBOX!=='true'))throw new ForbiddenException('Pagamento incompatível.');
  if(!payment.external_reference?.startsWith('compasso-addon:'))return {received:true};
  const key=payment.external_reference.slice('compasso-addon:'.length);
  this.repo.transaction(()=>{
   const purchase=this.repo.get<Purchase>(scope,'addon_purchases',key);
   if(!purchase || Math.round(payment.transaction_amount*100)!==purchase.priceCents)throw new BadRequestException('Valor ou contratação incompatível.');
   if(purchase.paymentId && purchase.paymentId!==String(payment.id))throw new BadRequestException('Contratação já possui outro pagamento.');
   if(payment.status==='approved' && (!payment.date_approved || !Number.isFinite(Date.parse(payment.date_approved)) || Date.parse(payment.date_approved)>Date.now()+60000))throw new BadRequestException('Data de pagamento inválida.');
   this.repo.put(scope,'addon_purchases',key,{...purchase,paymentId:String(payment.id),status:payment.status,paidAt:payment.date_approved || purchase.paidAt});
   const paid=this.repo.list<Purchase>(scope,'addon_purchases').filter(item=>item.tenantId===purchase.tenantId&&item.status==='approved'&&item.paidAt).sort((a,b)=>a.paidAt!.localeCompare(b.paidAt!));
   let expiry=0;for(const item of paid)expiry=Math.max(expiry,Date.parse(item.paidAt!))+30*86400000;
   this.repo.put(purchase.tenantId,'platform_entitlements','recommendation',{status:expiry>Date.now()?'active':'inactive',paid:paid.length>0,paymentId:paid.at(-1)?.paymentId||'',expiresAt:new Date(expiry).toISOString()});
  });return {received:true};
 }
}
