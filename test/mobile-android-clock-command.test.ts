/** Real ECDSA, custody, RLS and attendance transactions; synthetic enrollment is not hardware proof. */
import {generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {appendEvent,actorOf} from '../db/events';
import {hireEmployee} from '../core/org';
import {createAndroidEnrollmentService} from '../core/mobile-android-enrollment';
import {createAndroidClockSignatureService} from '../core/mobile-android-clock-signature';
import {createAndroidClockService,AttendancePhotoRequiredError} from '../packs/attendance/mobile-integrity';
import {revokeOwnIntegrityKey} from '../core/mobile-integrity-key';
import {setAttendancePolicy,setAttendancePhotoSetting} from '../packs/attendance/service';
import {onlineClockClientData,type OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
const settings={apiOrigin:'https://hr.example.com',target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
const service=createAndroidClockSignatureService(settings),clock=createAndroidClockService(settings);
let restore:(()=>Promise<void>)|undefined,base:Base;
beforeAll(async()=>{restore=await installCustodyDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-android-clock-receipt-secret-2026');await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();}finally{vi.unstubAllEnvs();await closeAll();}});
async function fixture(){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Android clock employee',primaryEmail:randomUUID()+'@clock.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const enrollment=createAndroidEnrollmentService(settings,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey,checkedAt:Date.now(),packageName:settings.target.packageName,versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
 const intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()},begin=await enrollment.begin(ctx,intent);
 const key=await enrollment.complete(ctx,{...intent,challengeId:begin.challenge.id,publicKeySpki:publicKey.export({type:'spki',format:'der'}),certificateChain:[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')]});
 return {ctx,privateKey,input:{employmentId:e.employmentId,appInstallationId:intent.appInstallationId,keyId:key.keyId,
  command:{requestId:randomUUID(),action:'in' as const,lat:3,lng:101,accuracy:4,sampledAt:Date.now()},
  evidence:{platform:'android' as const,appId:settings.target.packageName,appVersion:'1.0',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}}};
}
function signature(context:OnlineClockIntegrityData,key:KeyObject){return sign('sha256',Buffer.from(onlineClockClientData(context),'utf8'),key);}
async function challenge(id:string){return(await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,id)))[0];}
async function untouched(id:string){expect((await challenge(id)).consumedAt).toBeNull();expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);}
async function policy(){await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});}
describe('stored Android online command transaction',()=>{
 it('consumes a stored-key command once under concurrent ECDSA retries without an Apple counter',async()=>{
  const f=await fixture(),begin=await service.begin(f.ctx,f.input),op=vi.fn(async()=> 'checked');
  const results=await Promise.all([1,2].map(()=>service.consume(f.ctx,f.input,{challengeId:begin.challenge.id,signature:signature(begin.context,f.privateKey)},op)));
  expect(results.map(r=>r.state).sort()).toEqual(['already_consumed','consumed']);expect(op).toHaveBeenCalledOnce();
  const [key]=await owner.db.select().from(schema.mobileIntegrityKey).where(eq(schema.mobileIntegrityKey.id,f.input.keyId));expect(key.assertionCounter).toBe(0);
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,begin.challenge.id));expect(events.filter(e=>e.eventType==='mobile.integrity.signature.checked')).toHaveLength(1);expect(events.filter(e=>e.eventType==='mobile.integrity.challenge.consumed')).toHaveLength(1);
  expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);
 });
 it('binds coordinates, exact photo bytes, evidence, registered-device credential and installation',async()=>{
  const f=await fixture(),input={...f.input,deviceToken:randomUUID(),photo:Buffer.from('original photo'),mime:'image/jpeg' as const},begin=await service.begin(f.ctx,input),proof={challengeId:begin.challenge.id,signature:signature(begin.context,f.privateKey)},op=vi.fn(async()=>null);
  for(const changed of [{...input,command:{...input.command,lat:4}},{...input,photo:Buffer.from('changed photo')},{...input,evidence:{...input.evidence,mock:true}},{...input,deviceToken:randomUUID()},{...input,appInstallationId:randomUUID()}])await expect(service.consume(f.ctx,changed,proof,op)).rejects.toMatchObject({reason:'binding_conflict'});
  expect(op).not.toHaveBeenCalled();await untouched(begin.challenge.id);
  await service.consume(f.ctx,input,proof,async(_tx,checked)=>{expect(checked.photo).toEqual(input.photo);expect(checked.deviceToken).toBe(input.deviceToken);return null;});
 });
 it('rejects another private key and a signature over another challenge without consuming either',async()=>{
  const f=await fixture(),begin=await service.begin(f.ctx,f.input),other=await service.begin(f.ctx,{...f.input,command:{...f.input.command,requestId:randomUUID()}}),op=vi.fn(async()=>null);
  for(const bytes of [signature(begin.context,generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey),signature(other.context,f.privateKey)])await expect(service.consume(f.ctx,f.input,{challengeId:begin.challenge.id,signature:bytes},op)).rejects.toMatchObject({reason:'invalid_signature'});
  await untouched(begin.challenge.id);expect((await challenge(other.challenge.id)).consumedAt).toBeNull();expect(op).not.toHaveBeenCalled();
 });
 it('checks current actor, key ownership and revocation before callback',async()=>{
  const f=await fixture(),peer=await fixture(),begin=await service.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,signature:signature(begin.context,f.privateKey)},op=vi.fn(async()=>null);
  await expect(service.consume(peer.ctx,f.input,proof,op)).rejects.toThrow();await expect(service.begin(peer.ctx,{...peer.input,keyId:f.input.keyId})).rejects.toMatchObject({reason:'key_unavailable'});
  await revokeOwnIntegrityKey(f.ctx,{employmentId:f.input.employmentId,keyId:f.input.keyId});await expect(service.consume(f.ctx,f.input,proof,op)).rejects.toMatchObject({reason:'key_unavailable'});await untouched(begin.challenge.id);expect(op).not.toHaveBeenCalled();
 });
 it('refuses changed enrollment policy/origin, unsupported command builds and unavailable provenance',async()=>{
  const f=await fixture();
  for(const changed of [{...settings,apiOrigin:'https://other.example.com'},{...settings,target:{...settings.target,certificateDigests:[Buffer.alloc(32,2).toString('base64')]}},{...settings,target:{...settings.target,minimumOsPatchLevel:202611}}])await expect(createAndroidClockSignatureService(changed).begin(f.ctx,f.input)).rejects.toMatchObject({reason:'key_unavailable'});
  await expect(service.begin(f.ctx,{...f.input,evidence:{...f.input.evidence,buildVersion:'5'}})).rejects.toMatchObject({reason:'invalid_command'});
  vi.stubEnv('AI_CONFIG_SECRET','');await expect(service.begin(f.ctx,f.input)).rejects.toMatchObject({reason:'key_unavailable'});
 });
 it('snapshots signature and photo before awaiting locks, retaining exact checked bytes',async()=>{
  const f=await fixture(),input={...f.input,photo:Buffer.from('original photo'),mime:'image/jpeg' as const},begin=await service.begin(f.ctx,input),proof={challengeId:begin.challenge.id,signature:signature(begin.context,f.privateKey)};
  const pending=service.consume(f.ctx,input,proof,async(_tx,checked)=>{expect(checked.photo).toEqual(Buffer.from('original photo'));return null;});proof.signature.fill(0);input.photo.fill(0);expect((await pending).state).toBe('consumed');
 });
 it.each(['expiry','employment','revocation'] as const)('refuses %s changed while waiting for the stored key before invoking acceptance',async change=>{
  const f=await fixture();let begin=await service.begin(f.ctx,f.input);
  if(change==='expiry'){
   const row=await challenge(begin.challenge.id),now=Date.now();await owner.db.delete(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,row.id));await owner.db.insert(schema.mobileIntegrityChallenge).values({...row,issuedAt:new Date(now-118000),expiresAt:new Date(now+2000)});begin=await service.begin(f.ctx,f.input);
  }
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
  const holding=owner.db.transaction(async tx=>{await tx.select().from(schema.mobileIntegrityKey).where(eq(schema.mobileIntegrityKey.id,f.input.keyId)).for('update');entered();await held;if(change==='revocation')await tx.update(schema.mobileIntegrityKey).set({revokedAt:new Date()}).where(eq(schema.mobileIntegrityKey.id,f.input.keyId));});
  const operation=vi.fn(async()=>null);
  try{
   await started;const result=Promise.allSettled([service.consume(f.ctx,f.input,{challengeId:begin.challenge.id,signature:signature(begin.context,f.privateKey)},operation)]);
   try{
    const deadline=Date.now()+5000;let waiting=false;
    while(Date.now()<deadline){const rows=await owner.db.execute(sql`select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%mobile_integrity_key%' and query like '%for update%'`);if(rows.length){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
    expect(waiting).toBe(true);
    if(change==='expiry')await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${begin.challenge.expiresAt}::timestamptz-clock_timestamp())))+0.05)`);
    if(change==='employment')await owner.db.update(schema.employment).set({hiredOn:new Date(Date.now()+365*86400000).toISOString().slice(0,10)}).where(eq(schema.employment.id,f.input.employmentId));
   }finally{release();}
   await holding;expect((await result)[0]).toMatchObject({status:'rejected',reason:change==='expiry'?{reason:'expired'}:change==='employment'?{name:'OwnClockEmploymentUnavailableError'}:{reason:'key_unavailable'}});expect(operation).not.toHaveBeenCalled();await untouched(begin.challenge.id);
  }finally{release();await holding.catch(()=>{});}
 });
 it('rolls back challenge, audit and callback writes together on business refusal',async()=>{
  const f=await fixture(),begin=await service.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,signature:signature(begin.context,f.privateKey)};
  await expect(service.consume(f.ctx,f.input,proof,async tx=>{await tx.update(schema.person).set({fullName:'must roll back'}).where(eq(schema.person.id,f.ctx.personId!));throw new Error('business refused');})).rejects.toThrow('business refused');
  await untouched(begin.challenge.id);expect((await owner.db.select().from(schema.person).where(eq(schema.person.id,f.ctx.personId!)))[0].fullName).toBe('Android clock employee');
  expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.integrity.signature.checked'))).toHaveLength(0);
  expect((await service.consume(f.ctx,f.input,proof,async()=>null)).state).toBe('consumed');
 });
 it.each(['expiry','employment'] as const)('rechecks %s after callback work before committing',async change=>{
  const f=await fixture();let begin=await service.begin(f.ctx,f.input);
  if(change==='expiry'){
   const row=await challenge(begin.challenge.id),now=Date.now();await owner.db.delete(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,row.id));await owner.db.insert(schema.mobileIntegrityChallenge).values({...row,issuedAt:new Date(now-118000),expiresAt:new Date(now+2000)});begin=await service.begin(f.ctx,f.input);
  }
  await expect(service.consume(f.ctx,f.input,{challengeId:begin.challenge.id,signature:signature(begin.context,f.privateKey)},async tx=>{
   if(change==='employment')await owner.db.update(schema.employment).set({hiredOn:new Date(Date.now()+365*86400000).toISOString().slice(0,10)}).where(eq(schema.employment.id,f.input.employmentId));
   if(change==='expiry'){await appendEvent(tx,{tenantId:f.ctx.tenantId,aggregateType:'mobile-integrity-challenge',aggregateId:begin.challenge.id,eventType:'test.android-clock.rollback',actor:actorOf(f.ctx),subjectEmploymentId:f.input.employmentId,payload:{synthetic:true}});await tx.execute(sql`select pg_sleep(2.2)`);}return null;
  })).rejects.toMatchObject(change==='employment'?{name:'OwnClockEmploymentUnavailableError'}:{reason:'expired'});await untouched(begin.challenge.id);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'test.android-clock.rollback'))).toHaveLength(0);expect((await owner.db.select().from(schema.person).where(eq(schema.person.id,f.ctx.personId!)))[0].fullName).toBe('Android clock employee');
 });
});
describe('Android signed command uses authoritative attendance acceptance',()=>{
 it('commits one punch and linked recoverable receipt under concurrent retries, including after revocation',async()=>{
  await policy();const f=await fixture(),begin=await clock.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,signature:signature(begin.context,f.privateKey)};
  const [a,b]=await Promise.all([clock.complete(f.ctx,f.input,proof),clock.complete(f.ctx,f.input,proof)]);expect(a).toEqual(b);expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);
  const links=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'));expect(links).toHaveLength(1);expect(links[0].payload).toMatchObject({keyId:f.input.keyId,proofKind:'google_key_generation_proof',verification:'command_signature'});expect(links[0].payload).not.toHaveProperty('counter');expect(a).not.toHaveProperty('verifiedLocation');
  await revokeOwnIntegrityKey(f.ctx,{employmentId:f.input.employmentId,keyId:f.input.keyId});vi.stubEnv('AI_CONFIG_SECRET','');expect(await clock.complete(f.ctx,f.input,proof)).toEqual(a);
  await expect(clock.complete(f.ctx,{...f.input,command:{...f.input.command,lat:4}},proof)).rejects.toMatchObject({reason:'binding_conflict'});
 });
 it('rolls back proof consumption and attendance writes on punch insertion failure',async()=>{
  await policy();const f=await fixture(),begin=await clock.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,signature:signature(begin.context,f.privateKey)};
  await owner.db.execute(sql`create function app.test_android_punch_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic punch refusal';end;$$`);await owner.db.execute(sql`create trigger zz_test_android_punch_failure before insert on attendance_punch for each row execute function app.test_android_punch_failure()`);
  try{await expect(clock.complete(f.ctx,f.input,proof)).rejects.toThrow();await untouched(begin.challenge.id);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'mobile.integrity.signature.checked'))).toHaveLength(0);}
  finally{await owner.db.execute(sql`drop trigger zz_test_android_punch_failure on attendance_punch`);await owner.db.execute(sql`drop function app.test_android_punch_failure()`);}
  expect((await clock.complete(f.ctx,f.input,proof)).direction).toBe('in');
 });
 it('keeps current photo policy authoritative and leaves the challenge unconsumed on refusal',async()=>{
  await policy();const f=await fixture(),begin=await clock.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,signature:signature(begin.context,f.privateKey)};
  await setAttendancePhotoSetting(adminCtx(base),{employmentId:f.input.employmentId,setting:'required'});await expect(clock.complete(f.ctx,f.input,proof)).rejects.toBeInstanceOf(AttendancePhotoRequiredError);await untouched(begin.challenge.id);
  await setAttendancePhotoSetting(adminCtx(base),{employmentId:f.input.employmentId,setting:'optional'});expect((await clock.complete(f.ctx,f.input,proof)).photoAvailable).toBe(false);
 });
});
