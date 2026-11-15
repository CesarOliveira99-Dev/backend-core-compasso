import 'reflect-metadata';
import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHmac} from 'node:crypto';
import {Context} from '../dist/core/application/context.js';import {DocumentRepository} from '../dist/core/infrastructure/document.repository.js';import {PaymentsService} from '../dist/modules/payments/payments.service.js';
test('signed addon payment grants 30 days once, rejects mismatches, and refund revokes entitlement',async()=>{
 process.env.DATABASE_PATH=':memory:';process.env.MP_SANDBOX='true';process.env.COMPASSO_RECOMMENDATION_PRICE_CENTS='1000';process.env.MP_PLATFORM_ACCESS_TOKEN='fixture-token';process.env.MP_PLATFORM_USER_ID='123456';process.env.MP_WEBHOOK_SECRET='fixture-secret';process.env.APP_URL='https://fixture.test';process.env.PUBLIC_API_URL='https://api.fixture.test/v1';
 const repo=new DocumentRepository(),service=new PaymentsService(new Context(repo)),actor={id:'owner',tenantId:'shop',role:'admin' as const,name:'Owner',email:'owner@fixture.test',phone:'18999990000'};
 for(let index=0;index<10;index++){repo.put('shop','appointments','a'+index,{id:'a'+index,customerId:'c'+index,status:'completed'});repo.put('shop','feedback','r'+index,{id:'r'+index,customerId:'c'+index,appointmentId:'a'+index,rating:5});}
 const key=randomUUID();let ref='';let payment:any={id:42,collector_id:123456,currency_id:'BRL',transaction_amount:10,live_mode:false,status:'approved',date_approved:new Date().toISOString()};
 const original=globalThis.fetch;globalThis.fetch=async(_url,input)=>{if(input?.method==='POST'){ref=JSON.parse(input.body as string).external_reference;return Response.json({sandbox_init_point:'https://sandbox.fixture.test/pay',init_point:'https://fixture.test/pay'});}return Response.json({...payment,external_reference:ref});};
 const ts=String(Date.now()),signature='ts='+ts+',v1='+createHmac('sha256','fixture-secret').update(`id:42;request-id:fixture;ts:${ts};`).digest('hex');
 try{await service.addon.purchase(actor,{idempotencyKey:key});await assert.rejects(service.webhook('42','fixture','invalid',{type:'payment',user_id:123456}));payment.transaction_amount=1;await assert.rejects(service.webhook('42','fixture',signature,{type:'payment',user_id:123456}));payment.transaction_amount=10;
 await service.webhook('42','fixture',signature,{type:'payment',user_id:123456});const entitlement=repo.get<any>('shop','platform_entitlements','recommendation');assert.equal(entitlement.paid,true);assert.equal(Date.parse(entitlement.expiresAt)-Date.parse(payment.date_approved),30*86400000);
 await service.webhook('42','fixture',signature,{type:'payment',user_id:123456});assert.equal(repo.get<any>('shop','platform_entitlements','recommendation').expiresAt,entitlement.expiresAt);
 payment.status='refunded';await service.webhook('42','fixture',signature,{type:'payment',user_id:123456});assert.equal(repo.get<any>('shop','platform_entitlements','recommendation').status,'inactive');assert.equal(repo.get<any>('shop','platform_entitlements','recommendation').paid,false);
 await assert.rejects(service.addon.purchase({...actor,role:'customer'},{idempotencyKey:randomUUID()}));
 }finally{globalThis.fetch=original;}
});
