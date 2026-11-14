import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personNameSchema, phoneSchema } from '../dist/core/application/person.schemas.js';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { IdentityService } from '../dist/modules/identity/application/identity-service.js';
import { GoogleIdentity } from '../dist/modules/identity/application/google-identity.js';
import { CustomersService } from '../dist/modules/customers/application/customers-service.js';
process.env.DATABASE_PATH=':memory:';
test('personal names accept Unicode accents and punctuation but never numeric characters',()=>{
 for(const name of ["João D'Ávila",'Ana-Maria','José da Silva','Jo\u0061\u0303o','李明'])assert.equal(personNameSchema.safeParse(name).success,true,name);
 for(const name of ['','A','123','João 2','João ٢','Ana🙂','---','A'.repeat(101)])assert.equal(personNameSchema.safeParse(name).success,false,name);
 assert.equal(personNameSchema.parse('  Ana   Maria  '),'Ana Maria');
});
test('telephone accepts Brazilian formatted or raw numbers and optional 55; overflow and letters are rejected',()=>{
 for(const phone of ['(18) 99749-9717','(18) 3749-9717','18997499717','+55 (18) 99749-9717','5518997499717'])assert.equal(phoneSchema.safeParse(phone).success,true,phone);
 for(const phone of ['','18999','0018997499717','18997499717123','12345678901234','(18) 99749-ABCD','18'+' '.repeat(20)+'997499717'])assert.equal(phoneSchema.safeParse(phone).success,false,phone);
 assert.equal(phoneSchema.parse('+55 (18) 99749-9717'),'5518997499717');
});
test('direct API-service registration and profile update cannot bypass the name or phone rules and failed input writes nothing',()=>{
 const repo=new DocumentRepository(),context=new Context(repo),identity=new IdentityService(context,new GoogleIdentity());
 const input={role:'customer',name:'Ana Maria',phone:'(18) 99749-9717',email:'person@test.local',password:'StrongPassword123'};
 for(const invalid of [{name:'Ana 2'},{phone:'189974997171234'}])assert.throws(()=>identity.register({...input,...invalid}));
 assert.equal(repo.list('system','accounts').length,0);assert.equal(repo.list('system','stores').length,0);
 const account=identity.register(input);assert.equal(account.user.phone,'18997499717');
 const customers=new CustomersService(context);
 assert.throws(()=>customers.update(account.user,{name:'Ana 99',phone:input.phone}));
 assert.equal(customers.profile(account.user).name,'Ana Maria');
});
test('Google onboarding can correct a numeric display name without changing verified identity',async t=>{
 process.env.GOOGLE_CLIENT_ID='test.apps.googleusercontent.com';const repo=new DocumentRepository(),google=new GoogleIdentity(),identity=new IdentityService(new Context(repo),google);
 t.mock.method(google,'verify',async()=>({sub:'google-person',email:'verified@test.local',name:'Ana 99'}));
 const pending=await identity.google({...identity.googleChallenge(),credential:'credential-long-enough-for-test'});
 assert.throws(()=>identity.completeGoogle({enrollmentToken:pending.enrollmentToken,role:'customer',phone:'18997499717'}),/números/);
 const account=identity.completeGoogle({enrollmentToken:pending.enrollmentToken,role:'customer',phone:'18997499717',name:'Ana Maria',email:'wrong@test.local',sub:'wrong'});
 assert.equal(account.user.name,'Ana Maria');assert.equal(account.user.email,'verified@test.local');
});
