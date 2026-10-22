import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {sendHomeGreeting,readHomeGreeting} from '../core/employee-home-greetings';
import {readHomeCelebrationPage} from '../core/employee-home-sharing';
import {saveEmployeeHomeConfiguration} from '../core/employee-home-configuration';
import {saveOwnHomePersonPrivacy} from '../core/employee-home-person-privacy';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {todayInKualaLumpur} from '../lib/hr-date';
import {erasePersonPii} from '../core/pdpa';
import {dispatchNotifications,markNotificationRead,projectHomeGreetingInTx} from '../core/notifications';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,caller:SessionContext;
vi.mock('../lib/session',()=>({getSession:async()=>caller}));
const {POST}=await import('../app/api/home/greetings/route');
const today=()=>todayInKualaLumpur();
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();process.env.NOTIFICATIONS_ENABLED='1';b=await seedBase();});
async function worker(name:string,personId?:string){
 const hired=await hireEmployee(adminCtx(b),{person:personId?{id:personId}:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:String(Number(today().slice(0,4))-4)+today().slice(4)});
 const ctx:SessionContext={...adminCtx(b),userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee']};
 await owner.db.update(s.person).set({dateOfBirth:'2000'+today().slice(4)}).where(eq(s.person.id,hired.personId));
 return {...hired,ctx};
}
async function configure(enabled=true,ordinal=0){
 const configuration=defaultEmployeeHomeConfiguration();configuration.celebrations={enabled,scope:'department'};
 return saveEmployeeHomeConfiguration(adminCtx(b),{companyId:b.companyId,audienceRole:'employee',configuration,
  expectedOrdinal:ordinal,reason:'Fictional explicit greeting acceptance'});
}
function command(own:Awaited<ReturnType<typeof worker>>,target:Awaited<ReturnType<typeof worker>>){
 return {version:1,employmentId:own.employmentId,recipientEmploymentId:target.employmentId,kind:'birthday',occurrenceDate:today(),nonce:randomUUID(),message:'Hello தமிழ் ไทย Nguyễn <b>plain text</b>'};
}
const sendRaw=(ctx:SessionContext,p:ReturnType<typeof command>)=>withTenant(ctx,tx=>tx.execute<{receipt:unknown}>(sql`SELECT app.home_greeting_send_begin(${p.employmentId}::uuid,
 ${p.recipientEmploymentId}::uuid,${p.kind},${p.occurrenceDate}::date,${p.nonce}::uuid,${p.message}) AS receipt`));
const request=(body:unknown,origin='http://localhost')=>new Request('http://localhost/api/home/greetings',{
 method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function counts(){const [row]=await owner.db.execute<{greetings:number;events:number;notifications:number;intents:number}>(sql`SELECT
 (SELECT count(*)::int FROM app.home_greeting) AS greetings,
 (SELECT count(*)::int FROM domain_event WHERE event_type='employee-home.greeting.sent') AS events,
 (SELECT count(*)::int FROM notification WHERE kind='employee-home.greeting') AS notifications,
 (SELECT count(*)::int FROM app.home_greeting_send_intent) AS intents`);return row;}
describe('explicit Home greeting transaction and private content',()=>{
 it('reading creates nothing; explicit edited Send creates exactly one generic notification and private plaintext',async()=>{
  const own=await worker('Fictional sender'),target=await worker('Fictional recipient');await configure();
  expect((await readHomeCelebrationPage(own.ctx,own.employmentId)).items.length).toBeGreaterThan(0);
  expect(await counts()).toEqual({greetings:0,events:0,notifications:0,intents:0});
  const p=command(own,target),receipt=await sendHomeGreeting(own.ctx,p);
  expect(receipt).toEqual({version:1,employmentId:own.employmentId,nonce:p.nonce,greetingId:expect.any(String),state:'sent'});
  expect(await counts()).toEqual({greetings:1,events:1,notifications:1,intents:0});
  expect(await readHomeGreeting(target.ctx,target.employmentId,receipt.greetingId)).toMatchObject({message:p.message,state:'sent',sentByMe:false});
  expect(await readHomeGreeting(own.ctx,own.employmentId,receipt.greetingId)).toMatchObject({message:p.message,sentByMe:true});
  const events=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'employee-home.greeting.sent'));
  expect(events).toHaveLength(1);expect(events[0].payload).toEqual({greetingId:receipt.greetingId});
  const notices=await owner.db.select().from(s.notification).where(eq(s.notification.kind,'employee-home.greeting'));
  expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({recipientEmploymentId:target.employmentId,title:'employeeHome.greetingNotification.title',
   body:'employeeHome.greetingNotification.body',linkPath:'/me/greetings/'+receipt.greetingId,severity:'info'});
  expect(JSON.stringify([...events,...notices])).not.toContain(p.message);
  const [mail]=await owner.db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM notification_delivery WHERE channel='email' AND source_event_id=${events[0].id}::uuid`);
  expect(mail.n).toBe(0);
 });
 it('concurrent exact nonce retries converge; changing its body refuses without creating a second projection',async()=>{
  const own=await worker('Fictional sender'),target=await worker('Fictional recipient');await configure();const p=command(own,target);
  const receipts=await Promise.all([sendHomeGreeting(own.ctx,p),sendHomeGreeting(own.ctx,p)]);
  expect(receipts[0]).toEqual(receipts[1]);expect(await counts()).toEqual({greetings:1,events:1,notifications:1,intents:0});
  await expect(sendHomeGreeting(own.ctx,{...p,message:'Different message'})).rejects.toThrow();
  const before=await counts();await dispatchNotifications(adminCtx(b));expect(await counts()).toEqual(before);
 });
 it('requires current enabled audience and occurrence, own sender and peer opt-in at Send',async()=>{
  const own=await worker('Fictional sender'),target=await worker('Fictional recipient'),stranger=await worker('Fictional other');const p=command(own,target);
  await expect(sendHomeGreeting(own.ctx,p)).rejects.toThrow();await configure();
  await saveOwnHomePersonPrivacy(target.ctx,{expectedOrdinal:0,hideBirthday:true,hideAnniversary:false});
  await expect(sendHomeGreeting(own.ctx,p)).rejects.toThrow();
  await saveOwnHomePersonPrivacy(target.ctx,{expectedOrdinal:1,hideBirthday:false,hideAnniversary:false});
  await expect(sendHomeGreeting(stranger.ctx,p)).rejects.toThrow();
  await expect(sendHomeGreeting(own.ctx,{...p,occurrenceDate:'2000-01-01'})).rejects.toThrow();
  await configure(false,1);await expect(sendHomeGreeting(own.ctx,p)).rejects.toThrow();
  expect(await counts()).toEqual({greetings:0,events:0,notifications:0,intents:0});
 });
 it('refuses incomplete raw commands, forged events, cloned notifications and raw private content access',async()=>{
  const own=await worker('Fictional sender'),target=await worker('Fictional recipient');await configure();const p=command(own,target);
  await expect(sendRaw(own.ctx,p)).rejects.toThrow();expect(await counts()).toEqual({greetings:0,events:0,notifications:0,intents:0});
  await expect(withTenant(own.ctx,tx=>tx.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'employee-home-greeting',aggregateId:randomUUID(),
   eventType:'employee-home.greeting.sent',actorType:'user',actorId:own.ctx.userId,subjectEmploymentId:target.employmentId,payload:{greetingId:randomUUID()}}))).rejects.toThrow();
  const receipt=await sendHomeGreeting(own.ctx,p),[notice]=await owner.db.select().from(s.notification).where(eq(s.notification.kind,'employee-home.greeting'));
  await expect(withTenant(target.ctx,tx=>tx.insert(s.notification).values({...notice,id:randomUUID()}))).rejects.toThrow();
  await expect(withTenant(own.ctx,tx=>tx.execute(sql`SELECT message FROM app.home_greeting_content`))).rejects.toThrow();
  await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`SELECT message FROM app.home_greeting_content`))).rejects.toThrow();
  await markNotificationRead(target.ctx,notice.id);
  expect((await owner.db.select().from(s.notification).where(eq(s.notification.id,notice.id)))[0].readAt).not.toBeNull();
  await expect(withTenant(target.ctx,tx=>tx.update(s.notification).set({body:'Changed'}).where(eq(s.notification.id,notice.id)))).rejects.toThrow();
  await withTenant(target.ctx,tx=>tx.delete(s.notification).where(eq(s.notification.id,notice.id)));
  expect(await readHomeGreeting(target.ctx,target.employmentId,receipt.greetingId)).toMatchObject({message:p.message});
 });
 it('does not lend sender history to another login of that person or to an HR/manager reader',async()=>{
  const own=await worker('Fictional sender'),target=await worker('Fictional recipient'),other=await worker('Fictional outsider');await configure();
  const receipt=await sendHomeGreeting(own.ctx,command(own,target));
  const secondLogin={...own.ctx,userId:await createAppUser(b.tenantId,own.personId,'employee')};
  await expect(readHomeGreeting(secondLogin,own.employmentId,receipt.greetingId)).rejects.toThrow();
  await expect(readHomeGreeting(other.ctx,other.employmentId,receipt.greetingId)).rejects.toThrow();
  await expect(readHomeGreeting(adminCtx(b),target.employmentId,receipt.greetingId)).rejects.toThrow();
 });
 it('rolls back a command when projection fails and when the caller aborts after projection',async()=>{
  const own=await worker('Fictional sender'),target=await worker('Fictional recipient');await configure();const p=command(own,target);
  await expect(withTenant(own.ctx,async tx=>{
   const [row]=await tx.execute<{receipt:{greetingId:string}}>(sql`SELECT app.home_greeting_send_begin(${p.employmentId}::uuid,
    ${p.recipientEmploymentId}::uuid,${p.kind},${p.occurrenceDate}::date,${p.nonce}::uuid,${p.message}) AS receipt`);
   await projectHomeGreetingInTx(tx,row.receipt.greetingId);throw Error('Fictional abort');
  })).rejects.toThrow('Fictional abort');
  expect(await counts()).toEqual({greetings:0,events:0,notifications:0,intents:0});
 });
 it('erases both sender/recipient private content via canonical privacy owner and retains terminal nonce receipts',async()=>{
  const own=await worker('Fictional sender'),target=await worker('Fictional recipient');await configure();const p=command(own,target);
  const receipt=await sendHomeGreeting(own.ctx,p);
  const report=await erasePersonPii(adminCtx(b),{subjectEmploymentId:target.employmentId,scope:'contact',requestRef:'fictional-home586',reason:'Fictional private message retention cleanup'});
  expect(report.erased).toContain('homeGreetingMessages');
  expect(await readHomeGreeting(own.ctx,own.employmentId,receipt.greetingId)).toMatchObject({state:'erased',message:null});
  expect(await sendHomeGreeting(own.ctx,p)).toEqual({...receipt,state:'erased'});
  const [state]=await owner.db.execute<{bodies:number;hashes:number;intents:number;effects:number}>(sql`SELECT
   (SELECT count(*)::int FROM app.home_greeting_content WHERE message IS NOT NULL) AS bodies,
   (SELECT count(*)::int FROM app.home_greeting_content WHERE message_hash IS NOT NULL) AS hashes,
   (SELECT count(*)::int FROM app.home_greeting_erasure_intent) AS intents,
   (SELECT count(*)::int FROM app.home_greeting_erasure_effect) AS effects`);
  expect(state).toEqual({bodies:0,hashes:0,intents:0,effects:0});
 });
 it('requires same-origin bounded exact JSON and returns a sender-bound private no-store receipt',async()=>{
  const own=await worker('Fictional sender'),target=await worker('Fictional recipient');await configure();caller=own.ctx;const p=command(own,target);
  expect((await POST(request(p,'https://other.invalid'))).status).toBe(400);
  expect((await POST(request({...p,role:'hr_admin'}))).status).toBe(400);
  expect((await POST(request({...p,message:'x'.repeat(5000)}))).status).toBe(400);
  expect(await counts()).toEqual({greetings:0,events:0,notifications:0,intents:0});
  const response=await POST(request(p));expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  expect(await response.json()).toMatchObject({employmentId:own.employmentId,nonce:p.nonce,state:'sent'});
 });
});
