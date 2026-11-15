import 'reflect-metadata';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '../dist/core/application/context.js';
import {DocumentRepository} from '../dist/core/infrastructure/document.repository.js';
import {IdentityService} from '../dist/modules/identity/application/identity-service.js';
import {AccountRecovery} from '../dist/modules/identity/application/account-recovery.js';
import {AppointmentsService} from '../dist/modules/appointments/application/appointments-service.js';
import {ProfessionalsService} from '../dist/modules/professionals/professionals.module.js';
const password='FixtureOnly123!';
function setup(){process.env.DATABASE_PATH=':memory:'; const repo=new DocumentRepository(),context=new Context(repo),identity=new IdentityService(context,{verify:async()=>({sub:'fake-google',email:'google@fixture.test',name:'Google Worker'})} as any);const owner=identity.register({slug:'alpha',name:'Owner',email:'owner@fixture.test',phone:'18999990000',role:'admin',password});return {repo,context,identity,owner};}
test('store invitation grants only employee role, is reusable within limits, rotating invalidates old links and disabling revokes sessions',()=>{
 const {identity,owner}=setup();const invite=identity.memberships.invite(owner.user);
 const employee=identity.session(identity.memberships.register(invite.token,{name:'Worker',email:'worker@fixture.test',phone:'18999990000',password,confirmPassword:password,role:'admin'}));
 assert.equal(employee.user.role,'employee');assert.equal(employee.user.tenantId,owner.user.tenantId);assert.ok(employee.user.professionalId);
 assert.equal(identity.login({email:employee.user.email,password}).user?.role,'employee');
 const same=identity.memberships.accept(invite.token,identity.member(employee.user));assert.equal(same.id,employee.user.id);
 identity.memberships.invite(owner.user);assert.throws(()=>identity.memberships.preview(invite.token));
 assert.throws(()=>identity.memberships.invite(employee.user));
 identity.memberships.setActive(owner.user,employee.user.id,false);assert.throws(()=>identity.authenticate(employee.token));
});
test('one signed-in identity can visit and return across stores without inheriting administration',()=>{
 const {identity,owner}=setup();const second=identity.register({slug:'beta',name:'Other Owner',email:'other@fixture.test',phone:'18999990000',role:'admin',password});
 const visitor=identity.memberships.switchStore(owner.user,'beta');assert.equal(visitor.role,'customer');assert.equal(visitor.tenantId,second.user.tenantId);assert.equal(visitor.identityId,owner.user.identityId);
 assert.equal(identity.memberships.switchStore(visitor,'alpha').role,'admin');
 assert.equal(identity.memberships.switchStore(owner.user,'beta').id,visitor.id);
});
test('employee may view and change own appointments but not another professional or payment',()=>{
 const {identity,owner,repo,context}=setup();const invite=identity.memberships.invite(owner.user);const employee=identity.session(identity.memberships.register(invite.token,{name:'Worker',email:'worker@fixture.test',phone:'18999990000',password,confirmPassword:password}));
 const service=new AppointmentsService(context,new ProfessionalsService(context));
 const record={id:'own',customerId:'client',itemId:'cut',professionalId:employee.user.professionalId,startsAt:'2099-01-01T12:00:00.000Z',endsAt:'2099-01-01T13:00:00.000Z',status:'confirmed',paymentStatus:'pending',priceCents:5000};
 repo.put(owner.user.tenantId,'appointments','own',record);repo.put(owner.user.tenantId,'appointments','other',{...record,id:'other',professionalId:'principal'});
 assert.equal(service.list(employee.user).length,1);assert.throws(()=>service.transition(employee.user,'other',{status:'completed'}));assert.throws(()=>service.transition(employee.user,'own',{paymentStatus:'paid'}));
 assert.equal(service.transition(employee.user,'own',{status:'completed'}).status,'completed');
});
test('password recovery uses expiring single-use mail links, confirms email and revokes old sessions; duplicate registration does not create another store',async()=>{
 const {identity,owner,context,repo}=setup();process.env.APP_URL='https://compasso.fixture.test';let sent='';const recovery=new AccountRecovery(context,{configured:()=>true,send:async(_email,_subject,link)=>{sent=link;}});
 await recovery.request('password',{email:owner.user.email});const token=sent.split(':').at(-1)!;
 assert.throws(()=>recovery.complete({token,password:'AnotherOnly123!',confirmPassword:'different'}));
 recovery.complete({token,password:'AnotherOnly123!',confirmPassword:'AnotherOnly123!'});assert.throws(()=>identity.authenticate(owner.token));assert.throws(()=>recovery.complete({token,password,confirmPassword:password}));
 assert.equal(identity.login({email:owner.user.email,password:'AnotherOnly123!'}).user?.emailVerified,true);
 const input={idempotencyKey:crypto.randomUUID(),businessName:'New Shop',name:'New Owner',email:'new@fixture.test',phone:'18999990000',role:'admin',password,address:{postalCode:'19806060',street:'Rua',number:'1',district:'Centro',city:'Assis',state:'SP',complement:''}};
 const first=identity.register(input),again=identity.register(input);assert.equal(first.user.tenantId,again.user.tenantId);assert.equal(repo.list('system','stores').length,2);
});

test('Google invitation completion creates an employee once, preserves role on later normal login and does not accept replay',async()=>{
 const {identity,owner}=setup();process.env.GOOGLE_CLIENT_ID='fixture-only';
 const invitation=identity.memberships.invite(owner.user),challenge=identity.googleChallenge();
 const result=await identity.google({credential:'mock-credential-not-real-123',challenge:challenge.challenge,inviteToken:invitation.token});assert.equal(result.status,'onboarding_required');
 const completed=identity.completeGoogle({enrollmentToken:(result as any).enrollmentToken,phone:'18999990000'});assert.equal(completed.user.role,'employee');
 assert.throws(()=>identity.completeGoogle({enrollmentToken:(result as any).enrollmentToken,phone:'18999990000'}));
 const next=identity.googleChallenge();const login=await identity.google({credential:'mock-credential-not-real-123',challenge:next.challenge});assert.equal((login as any).user.role,'employee');assert.equal((login as any).user.id,completed.user.id);
});
