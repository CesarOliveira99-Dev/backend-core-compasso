import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { planPrice, requireEmployeeSeat, storeEntitlement } from '../dist/core/application/store-plans.js';
import { SubscriptionBilling } from '../dist/modules/payments/subscription-billing.js';
import { PaymentProviderRejected } from '../dist/modules/payments/payment-provider-error.js';
import { PaymentsService } from '../dist/modules/payments/payments.service.js';
process.env.DATABASE_PATH=':memory:';
const owner={id:'owner',tenantId:'store',role:'admin' as const,email:'owner@test.local',name:'Owner',phone:''};
function fixture() {
 Object.assign(process.env,{COMPASSO_SUBSCRIPTIONS_ENABLED:'true',MP_PLATFORM_ACCESS_TOKEN:'fixture',MP_PLATFORM_USER_ID:'123',MP_WEBHOOK_SECRET:'fixture',APP_URL:'https://test.local',PUBLIC_API_URL:'https://api.test.local/v1',MP_SANDBOX:'true'});
 const repo=new DocumentRepository();let price=99.9, reference='', puts=0, reject=false, lost=false, invoicePrice=99.9;
 const preapproval=()=>({id:'sub',collector_id:123,external_reference:reference,status:'authorized',init_point:'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=sub',auto_recurring:{frequency:1,frequency_type:'months',currency_id:'BRL',transaction_amount:price}});
 const call=async(path:string,_token?:string,body?:any,_key?:string,method?:string)=>{
   if(path==='/preapproval') {price=body.auto_recurring.transaction_amount;reference=body.external_reference;return preapproval();}
   if(path==='/preapproval/sub'&&method==='PUT') {puts++;if(reject)throw new PaymentProviderRejected('rejected');price=body.auto_recurring.transaction_amount;if(lost)throw new Error('lost response');return preapproval();}
   if(path==='/preapproval/sub')return preapproval();
   if(path.startsWith('/authorized_payments/search'))return {results:[{id:44}]};
   if(path==='/authorized_payments/44')return {id:44,preapproval_id:'sub',currency_id:'BRL',transaction_amount:invoicePrice,debit_date:new Date().toISOString(),payment:{id:42}};
   if(path==='/v1/payments/42')return {id:42,collector_id:123,currency_id:'BRL',transaction_amount:invoicePrice,live_mode:false,status:'approved',date_approved:new Date().toISOString()};
   throw new Error(path);
 };
 const billing=new SubscriptionBilling(new Context(repo),call as any);
 return {repo,billing,call,puts:()=>puts,reject:()=>{reject=true},lost:()=>{lost=true},invoicePrice:(n:number)=>{invoicePrice=n}};
}
test('Equipe prices are integer cents and extras cannot be attached to cheaper plans',()=>{
 assert.equal(planPrice('equipe',0),9990);assert.equal(planPrice('equipe',1),12490);assert.equal(planPrice('equipe',2),14990);
 for(const n of [-1,1.5,NaN,Infinity,91])assert.throws(()=>planPrice('equipe',n));
 assert.throws(()=>planPrice('essencial',1));assert.throws(()=>planPrice('profissional',1));
});
test('new Equipe subscription includes the selected extras in its actual provider amount',async()=>{
 const f=fixture();await f.billing.subscribe(owner,{planId:'equipe',extraEmployees:2});
 assert.equal(f.billing.status(owner).subscription?.priceCents,14990);
 assert.equal(f.billing.status(owner).subscription?.extraEmployees,2);
 assert.equal(storeEntitlement(f.repo,'store').mode,'expired','no paid invoice means no access');
 f.invoicePrice(149.9);await f.billing.invoice('44');
 assert.equal(storeEntitlement(f.repo,'store').plan?.employees,12);
 assert.equal(f.billing.status(owner).emailUsage.monthly.limit,5000);
 await assert.rejects(()=>f.billing.subscribe({...owner,tenantId:'another'},{planId:'essencial',extraEmployees:1}));
});
test('owner confirms recurring increase, the eleventh seat is guarded, retries are idempotent and old invoices still reconcile',async()=>{
 const f=fixture();await f.billing.subscribe(owner,{planId:'equipe'});await f.billing.invoice('44');
 for(let i=0;i<10;i++)f.repo.put('store','professionals',String(i),{id:String(i),active:true});
 assert.throws(()=>requireEmployeeSeat(f.repo,'store'),/R\$25,00/);
 await assert.rejects(()=>f.billing.changeExtras({...owner,role:'customer'},{extraEmployees:1,expectedPriceCents:12490}));
 await assert.rejects(()=>f.billing.changeExtras(owner,{extraEmployees:1,expectedPriceCents:1}));
 assert.equal(f.puts(),0);
 await f.billing.changeExtras(owner,{extraEmployees:1,expectedPriceCents:12490});
 assert.doesNotThrow(()=>requireEmployeeSeat(f.repo,'store')); assert.equal(f.billing.status(owner).subscription?.priceCents,12490);
 await f.billing.changeExtras(owner,{extraEmployees:1,expectedPriceCents:12490});assert.equal(f.puts(),1);
 await f.billing.invoice('44');assert.equal(storeEntitlement(f.repo,'store').mode,'active','old R$99.90 invoice remains valid');
 f.repo.put('store','professionals','eleven',{id:'eleven',active:true});
 await assert.rejects(()=>f.billing.changeExtras(owner,{extraEmployees:0,expectedPriceCents:9990}),/Desative/);
 f.repo.put('store','professionals','eleven',{id:'eleven',active:false});
 await f.billing.changeExtras(owner,{extraEmployees:0,expectedPriceCents:9990});
 assert.equal(f.billing.status(owner).subscription?.priceCents,9990);
 assert.throws(()=>requireEmployeeSeat(f.repo,'store'),/R\$25,00/);
});
test('lost update response blocks new seats and recovers without sending a second PUT',async()=>{
 const f=fixture();await f.billing.subscribe(owner,{planId:'equipe'});await f.billing.invoice('44');f.lost();
 await assert.rejects(()=>f.billing.changeExtras(owner,{extraEmployees:1,expectedPriceCents:12490}),/lost/);
 assert.equal(f.billing.status(owner).extrasPending,true);
 assert.throws(()=>requireEmployeeSeat(f.repo,'store'),/Aguarde/);
 await f.billing.changeExtras(owner,{extraEmployees:1,expectedPriceCents:12490});
 assert.equal(f.puts(),1);assert.equal(f.billing.status(owner).extrasPending,false);
 assert.equal(f.billing.status(owner).subscription?.extraEmployees,1);
 assert.equal(f.repo.get('other','billing','subscription'),undefined);
});
test('definitive provider rejection never grants extras and clears only its rejected intention',async()=>{
 const f=fixture();await f.billing.subscribe(owner,{planId:'equipe'});await f.billing.invoice('44');f.reject();
 await assert.rejects(()=>f.billing.changeExtras(owner,{extraEmployees:1,expectedPriceCents:12490}),/rejected/);
 assert.equal(f.billing.status(owner).subscription?.extraEmployees,0);
 assert.equal(f.billing.status(owner).extrasPending,false);
});
test('real payments transport uses PUT to update the existing recurring subscription',async t=>{
 const f=fixture();const service=new PaymentsService(new Context(f.repo));
 t.mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
   const path=new URL(String(url)).pathname;
   const result=await f.call(path,'fixture',init?.body?JSON.parse(String(init.body)):undefined,undefined,init?.method);
   return Response.json(result);
 });
 await service.billing.subscribe(owner,{planId:'equipe'});await service.billing.invoice('44');
 await service.billing.changeExtras(owner,{extraEmployees:2,expectedPriceCents:14990});
 assert.equal(f.puts(),1);assert.equal(service.billing.status(owner).subscription?.priceCents,14990);
});

test('concurrent changes and staff additions wait until the provider confirms the first change',async()=>{
 const f=fixture();await f.billing.subscribe(owner,{planId:'equipe'});await f.billing.invoice('44');
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 const billing=new SubscriptionBilling(new Context(f.repo),(async(...args:Parameters<typeof f.call>)=>{if(args[4]==='PUT')await gate;return f.call(...args)}) as any);
 const first=billing.changeExtras(owner,{extraEmployees:1,expectedPriceCents:12490});
 assert.throws(()=>requireEmployeeSeat(f.repo,'store'),/Aguarde/);
 await assert.rejects(()=>billing.changeExtras(owner,{extraEmployees:2,expectedPriceCents:14990}),/Aguarde/);
 release();await first;assert.equal(f.puts(),1);assert.equal(billing.status(owner).subscription?.extraEmployees,1);
});

test('unconfirmed amount never grants the new capacity and refresh can recover it',async()=>{
 const f=fixture();await f.billing.subscribe(owner,{planId:'equipe'});await f.billing.invoice('44');
 const billing=new SubscriptionBilling(new Context(f.repo),(async(...args:Parameters<typeof f.call>)=>{
   const result=await f.call(...args);
   if(args[4]==='PUT')return {...result,auto_recurring:{...result.auto_recurring,transaction_amount:99.9}};
   return result;
 }) as any);
 await assert.rejects(()=>billing.changeExtras(owner,{extraEmployees:1,expectedPriceCents:12490}),/confirmação/);
 assert.equal(billing.status(owner).subscription?.extraEmployees,0);assert.equal(billing.status(owner).extrasPending,true);
 await billing.refresh(owner);assert.equal(billing.status(owner).subscription?.extraEmployees,1);assert.equal(f.puts(),1);
});

test('HTTP 400 from the real PUT transport is definitive and does not leave a paid extra seat',async t=>{
 const f=fixture();const service=new PaymentsService(new Context(f.repo));
 t.mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
   if(init?.method==='PUT')return Response.json({error:'rejected'},{status:400});
   return Response.json(await f.call(new URL(String(url)).pathname,'fixture',init?.body?JSON.parse(String(init.body)):undefined));
 });
 await service.billing.subscribe(owner,{planId:'equipe'});await service.billing.invoice('44');
 await assert.rejects(()=>service.billing.changeExtras(owner,{extraEmployees:1,expectedPriceCents:12490}),/HTTP 400, código rejected/);
 assert.equal(service.billing.status(owner).extrasPending,false);assert.equal(service.billing.status(owner).subscription?.extraEmployees,0);
});
