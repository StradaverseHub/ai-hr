/** Synthetic enrollment, real signatures, database locks, counters and transaction rollback. */
import {createHash,generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import cbor from 'cbor';
import sharp from 'sharp';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createAppleEnrollmentService,revokeOwnIntegrityKey} from '../core/mobile-apple-enrollment';
import {createAppleClockAssertionService} from '../core/mobile-apple-clock-assertion';
import {createAppleClockService} from '../packs/attendance/service';
import {captureNativeClock,abandonNativeClock,ownNativeClockReceipt,AttendancePhotoRequiredError,ClockConflictError} from '../core/attendance-clock';
import {setAttendancePolicy,setAttendancePhotoSetting,createClockingLocation,setClockingControl,registerDevice} from '../packs/attendance/service';
import {onlineClockClientData,type OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';

const settings={apiOrigin:'https://hr.example.com',target:{platform:'ios',appId:'ABCDEFGHIJ.ai.stradaverse.aihr.test',environment:'production',requiredMetadata:null}};
const service=createAppleClockAssertionService(settings);
let base:Base;
beforeAll(()=>vi.stubEnv('AI_CONFIG_SECRET','synthetic-mobile-key-receipt-secret-2026'));
beforeEach(async()=>{await resetDb();base=await seedBase();});
afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
async function fixture(){
  const e=await hireEmployee(adminCtx(base),{person:{fullName:'Assertion employee',primaryEmail:randomUUID()+'@assertion.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  const userId=await createAppUser(base.tenantId,e.personId,'employee');
  const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'});
  const keyId=createHash('sha256').update(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])).digest('base64');
  const enrollment=createAppleEnrollmentService(settings,{verifyProof:async()=>({publicKey,keyId,environment:'production',metadata:{status:'unavailable'},
    receipt:Buffer.from('synthetic'),receiptVerification:'not_checked',revocation:'not_checked'})});
  const intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()},begin=await enrollment.begin(ctx,intent);
  const key=await enrollment.complete(ctx,{...intent,challengeId:begin.challenge.id,vendorKeyId:keyId,attestation:Buffer.from('synthetic')});
  const input={employmentId:e.employmentId,appInstallationId:intent.appInstallationId,keyId:key.keyId,
    command:{requestId:randomUUID(),action:'in' as const,lat:3,lng:101,accuracy:4,sampledAt:Date.now()},
    evidence:{platform:'ios' as const,appId:'ai.stradaverse.aihr.test',appVersion:'1.0',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}};
  return {ctx,input,privateKey};
}
function assertion(context:OnlineClockIntegrityData,privateKey:KeyObject,counter=1){
  const auth=Buffer.alloc(37);createHash('sha256').update(settings.target.appId).digest().copy(auth);auth[32]=0x40;auth.writeUInt32BE(counter,33);
  const nonce=createHash('sha256').update(auth).update(createHash('sha256').update(onlineClockClientData(context)).digest()).digest();
  return cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,privateKey)});
}
async function counter(keyId:string){const [key]=await owner.db.select().from(schema.mobileIntegrityKey).where(eq(schema.mobileIntegrityKey.id,keyId));return key.assertionCounter;}
async function challenge(id:string){const [row]=await owner.db.select().from(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,id));return row;}
async function waitForOwnedKeyLock(){
  const until=Date.now()+5000;
  while(Date.now()<until){
    const rows=await owner.db.execute(sql`select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
      and wait_event_type='Lock' and query like '%mobile_integrity_key%' and query like '%for update%'`);
    if(rows.length)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('Owned key waiter not observed');
}
describe('stored Apple online assertion transaction',()=>{
  it('atomically checks a real signature, advances one counter and runs one duplicate callback',async()=>{
    const f=await fixture(),begin=await service.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)};
    expect(await counter(f.input.keyId)).toBe(0);
    const operation=vi.fn(async(_tx,checked)=>({requestId:checked.context.command.requestId}));
    const results=await Promise.all([service.consume(f.ctx,f.input,proof,operation),service.consume(f.ctx,f.input,proof,operation)]);
    expect(results.map(r=>r.state).sort()).toEqual(['already_consumed','consumed']);expect(operation).toHaveBeenCalledOnce();
    expect(await counter(f.input.keyId)).toBe(1);expect((await challenge(begin.challenge.id)).consumedAt).not.toBeNull();
    const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,begin.challenge.id));
    expect(events.filter(e=>e.eventType==='mobile.integrity.assertion.checked')).toHaveLength(1);
    expect(events.filter(e=>e.eventType==='mobile.integrity.challenge.consumed')).toHaveLength(1);
    const replay=await service.consume(f.ctx,f.input,{...proof,assertion:Buffer.from('not reverified')},operation);
    expect(replay.state).toBe('already_consumed');expect(operation).toHaveBeenCalledOnce();
    expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);
  });
  it('binds exact submitted photo bytes and refuses changed commands, evidence or installation',async()=>{
    const f=await fixture(),input={...f.input,photo:Buffer.from('exact bytes'),mime:'image/jpeg' as const},begin=await service.begin(f.ctx,input);
    expect(begin.context.command.photo).toEqual({sha256:createHash('sha256').update(input.photo).digest('hex'),byteLength:11,mimeType:'image/jpeg'});
    const proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)},operation=vi.fn(async()=>null);
    for(const altered of [{...input,photo:Buffer.from('changed bytes')},{...input,command:{...input.command,lat:4}},
      {...input,evidence:{...input.evidence,mock:true}},{...input,appInstallationId:randomUUID()}])
      await expect(service.consume(f.ctx,altered,proof,operation)).rejects.toMatchObject({reason:'binding_conflict'});
    await expect(service.begin(f.ctx,{...input,photo:Buffer.alloc(2*1024*1024+1)})).rejects.toMatchObject({reason:'invalid_command'});
    expect(operation).not.toHaveBeenCalled();expect(await counter(input.keyId)).toBe(0);
    await service.consume(f.ctx,input,proof,async(_tx,checked)=>{expect(checked.photo).toEqual(input.photo);return null;});
  });
  it('rejects wrong signatures and larger forged counters without consuming challenge or advancing key',async()=>{
    const f=await fixture(),begin=await service.begin(f.ctx,f.input),operation=vi.fn(async()=>null);
    const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey;
    await expect(service.consume(f.ctx,f.input,{challengeId:begin.challenge.id,assertion:assertion(begin.context,other,99)},operation)).rejects.toMatchObject({reason:'invalid_signature'});
    expect(await counter(f.input.keyId)).toBe(0);expect((await challenge(begin.challenge.id)).consumedAt).toBeNull();expect(operation).not.toHaveBeenCalled();
  });
  it('rolls back counter, challenge and callback writes together when business acceptance throws',async()=>{
    const f=await fixture(),begin=await service.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)};
    await expect(service.consume(f.ctx,f.input,proof,async tx=>{
      await tx.update(schema.person).set({fullName:'must roll back'}).where(eq(schema.person.id,f.ctx.personId!));throw new Error('business refusal');
    })).rejects.toThrow('business refusal');
    expect(await counter(f.input.keyId)).toBe(0);expect((await challenge(begin.challenge.id)).consumedAt).toBeNull();
    const [person]=await owner.db.select().from(schema.person).where(eq(schema.person.id,f.ctx.personId!));expect(person.fullName).toBe('Assertion employee');
    expect((await service.consume(f.ctx,f.input,proof,async()=> 'accepted by test owner')).state).toBe('consumed');
  });
  it('rechecks revocation, actor eligibility and configured metadata before callback',async()=>{
    const f=await fixture(),peer=await fixture(),begin=await service.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)},operation=vi.fn(async()=>null);
    await expect(service.consume(peer.ctx,f.input,proof,operation)).rejects.toThrow();
    const strict=createAppleClockAssertionService({...settings,target:{...settings.target,requiredMetadata:{validationCategory:4,bundleVersions:['4']}}});
    await expect(strict.begin(f.ctx,f.input)).rejects.toMatchObject({reason:'key_unavailable'});
    await revokeOwnIntegrityKey(f.ctx,{employmentId:f.input.employmentId,keyId:f.input.keyId});
    await expect(service.consume(f.ctx,f.input,proof,operation)).rejects.toMatchObject({reason:'key_unavailable'});
    expect((await challenge(begin.challenge.id)).consumedAt).toBeNull();expect(await counter(f.input.keyId)).toBe(0);expect(operation).not.toHaveBeenCalled();
    await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,peer.ctx.userId!));
    await expect(service.begin(peer.ctx,peer.input)).rejects.toThrow();
  });
  it('serializes different challenges sharing a key, rejecting a reused counter after the first commits',async()=>{
    const f=await fixture(),secondInput={...f.input,command:{...f.input.command,requestId:randomUUID()}},a=await service.begin(f.ctx,f.input),b=await service.begin(f.ctx,secondInput);
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
    const first=service.consume(f.ctx,f.input,{challengeId:a.challenge.id,assertion:assertion(a.context,f.privateKey)},async()=>{entered();await held;return null;});
    try{
      await started;
      const second=service.consume(f.ctx,secondInput,{challengeId:b.challenge.id,assertion:assertion(b.context,f.privateKey)},async()=> 'must not run');
      const results=Promise.allSettled([first,second]);
      try{await waitForOwnedKeyLock();}finally{release();}
      const outcomes=await results;expect(outcomes[0].status).toBe('fulfilled');expect(outcomes[1]).toMatchObject({status:'rejected',reason:{reason:'replayed_counter'}});
      expect(await counter(f.input.keyId)).toBe(1);expect((await challenge(b.challenge.id)).consumedAt).toBeNull();
    }finally{release();await first.catch(()=>{});}
  });
  it('refuses a database counter-write veto before running business acceptance',async()=>{
    const f=await fixture(),begin=await service.begin(f.ctx,f.input),operation=vi.fn(async()=>null);
    await owner.db.execute(sql`create function app.test_key_counter_veto() returns trigger language plpgsql as $$begin return null;end;$$`);
    await owner.db.execute(sql`create trigger zz_test_key_counter_veto before update on mobile_integrity_key for each row execute function app.test_key_counter_veto()`);
    try{
      await expect(service.consume(f.ctx,f.input,{challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)},operation)).rejects.toMatchObject({reason:'counter_unavailable'});
      expect(operation).not.toHaveBeenCalled();expect(await counter(f.input.keyId)).toBe(0);expect((await challenge(begin.challenge.id)).consumedAt).toBeNull();
    }finally{
      await owner.db.execute(sql`drop trigger zz_test_key_counter_veto on mobile_integrity_key`);
      await owner.db.execute(sql`drop function app.test_key_counter_veto()`);
    }
  });
  it.each(['expiry','employment'] as const)('rechecks %s after an observably blocked key acquisition',async(change)=>{
    const f=await fixture();let begin=await service.begin(f.ctx,f.input);
    if(change==='expiry'){
      // Seed a short-lived challenge only in this disposable database; no production TTL override.
      const row=await challenge(begin.challenge.id),now=Date.now();
      await owner.db.delete(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,row.id));
      await owner.db.insert(schema.mobileIntegrityChallenge).values({...row,issuedAt:new Date(now-118000),expiresAt:new Date(now+2000)});
      begin=await service.begin(f.ctx,f.input);
    }
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
    const holding=owner.db.transaction(async tx=>{
      await tx.select().from(schema.mobileIntegrityKey).where(eq(schema.mobileIntegrityKey.id,f.input.keyId)).for('update');
      entered();await held;
    });
    const operation=vi.fn(async()=>null);
    try{
      await started;
      const pending=service.consume(f.ctx,f.input,{challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)},operation);
      const result=Promise.allSettled([pending]);
      try{
        await waitForOwnedKeyLock();
        if(change==='expiry')await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${begin.challenge.expiresAt}::timestamptz-clock_timestamp())))+0.05)`);
        else await owner.db.update(schema.employment).set({hiredOn:'2099-01-01'}).where(eq(schema.employment.id,f.input.employmentId));
      }finally{release();}
      await holding;
      const [outcome]=await result;expect(outcome.status).toBe('rejected');
      if(change==='expiry')expect(outcome).toMatchObject({reason:{reason:'expired'}});
      expect(operation).not.toHaveBeenCalled();expect(await counter(f.input.keyId)).toBe(0);expect((await challenge(begin.challenge.id)).consumedAt).toBeNull();
    }finally{release();await holding.catch(()=>{});}
  });
});

describe('signed Apple carrier using the real attendance writer',()=>{
  const clock=createAppleClockService(settings);
  const policy=()=>({companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
  async function counts(f:Awaited<ReturnType<typeof fixture>>,id:string){
    expect(await counter(f.input.keyId)).toBe(0);expect((await challenge(id)).consumedAt).toBeNull();
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);
    expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(0);
    expect(await owner.db.select().from(schema.attendance)).toHaveLength(0);
  }
  it('commits one punch, proof link, counter and recoverable actor receipt under concurrent retries',async()=>{
    const f=await fixture(),begin=await clock.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)};
    const [a,b]=await Promise.all([clock.complete(f.ctx,f.input,proof),clock.complete(f.ctx,f.input,proof)]);expect(a).toEqual(b);
    expect(await counter(f.input.keyId)).toBe(1);expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(1);
    const links=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'));
    expect(links).toHaveLength(1);expect(links[0]).toMatchObject({aggregateId:a.id,actorId:f.ctx.userId,subjectEmploymentId:f.input.employmentId,
      payload:{challengeId:begin.challenge.id,keyId:f.input.keyId,counter:1,proofKind:'apple_key_proof'}});
    expect(JSON.stringify(links)).not.toContain(proof.assertion.toString('base64'));
    expect(a).not.toHaveProperty('trustTier');expect(a).not.toHaveProperty('verifiedLocation');
    await revokeOwnIntegrityKey(f.ctx,{employmentId:f.input.employmentId,keyId:f.input.keyId});
    expect(await clock.complete(f.ctx,f.input,{...proof,assertion:Buffer.from('receipt reconciliation, not new proof')})).toEqual(a);
    expect(await ownNativeClockReceipt(f.ctx,f.input.employmentId,f.input.command.requestId)).toEqual(a);
    await expect(clock.complete(f.ctx,{...f.input,command:{...f.input.command,lat:4}},proof)).rejects.toMatchObject({reason:'binding_conflict'});
  });
  it('rolls back the proof and every attendance write on a real punch insertion failure, then retries safely',async()=>{
    const f=await fixture(),begin=await clock.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)};
    await owner.db.execute(sql`create function app.test_signed_punch_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic punch insertion refusal';end;$$`);
    await owner.db.execute(sql`create trigger zz_test_signed_punch_failure before insert on attendance_punch for each row execute function app.test_signed_punch_failure()`);
    try{
      await expect(clock.complete(f.ctx,f.input,proof)).rejects.toThrow();await counts(f,begin.challenge.id);
      for(const kind of ['attendance.clock.captured','attendance.clock.integrity.checked','mobile.integrity.assertion.checked'])
        expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,kind))).toHaveLength(0);
    }finally{
      await owner.db.execute(sql`drop trigger zz_test_signed_punch_failure on attendance_punch`);
      await owner.db.execute(sql`drop function app.test_signed_punch_failure()`);
    }
    expect((await clock.complete(f.ctx,f.input,proof)).direction).toBe('in');expect(await counter(f.input.keyId)).toBe(1);
  });
  it('keeps current photo policy authoritative and does not consume proof on a missing required photo',async()=>{
    const f=await fixture(),begin=await clock.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)};
    await setAttendancePhotoSetting(adminCtx(base),{employmentId:f.input.employmentId,setting:'required'});
    await expect(clock.complete(f.ctx,f.input,proof)).rejects.toBeInstanceOf(AttendancePhotoRequiredError);await counts(f,begin.challenge.id);
    await setAttendancePhotoSetting(adminCtx(base),{employmentId:f.input.employmentId,setting:'optional'});
    expect((await clock.complete(f.ctx,f.input,proof)).photoAvailable).toBe(false);
  });
  it('signs exact required-photo bytes and retains a defensive copy through asynchronous acceptance',async()=>{
    const f=await fixture();await setAttendancePhotoSetting(adminCtx(base),{employmentId:f.input.employmentId,setting:'required'});
    const photo=await sharp({create:{width:8,height:8,channels:3,background:'#15806f'}}).png().toBuffer(),digest=createHash('sha256').update(photo).digest('hex');
    const input={...f.input,photo,mime:'image/png' as const},begin=await clock.begin(f.ctx,input);
    expect(begin.context.command.photo).toEqual({sha256:digest,byteLength:photo.length,mimeType:'image/png'});
    const pending=clock.complete(f.ctx,input,{challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)});
    photo.fill(0); // The caller no longer owns the accepted byte snapshot after invoking completion.
    const receipt=await pending;expect(receipt.photoAvailable).toBe(true);
    const [capture]=await owner.db.select().from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.id,receipt.id));
    expect(capture.photoDigest).toBe(digest);expect(capture.photoMimeType).toBe('image/jpeg');
    expect((await sharp(capture.photoBytes!).metadata()).format).toBe('jpeg');
    expect(await counter(f.input.keyId)).toBe(1);
  });
  it('preserves uncertainty containment and the separate blocked-attempt audit without accepting attendance',async()=>{
    const f=await fixture(),input={...f.input,command:{...f.input.command,accuracy:20}},admin=adminCtx(base);
    const site=await createClockingLocation(admin,{companyIds:[base.companyId],name:'Signed office',lat:3,lng:101,radiusM:10});
    await setClockingControl(admin,{employmentId:input.employmentId,enabled:true,clockingLocationIds:[site.id]});
    const begin=await clock.begin(f.ctx,input),proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)};
    await expect(clock.complete(f.ctx,input,proof)).rejects.toMatchObject({name:'OutsideGeofenceError'});await counts(f,begin.challenge.id);
    expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.geofence.blocked'))).toHaveLength(1);
    expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'))).toHaveLength(0);
  });
  it('cannot retroactively upgrade an existing unsigned capture or bypass server-ordered abandonment',async()=>{
    const f=await fixture(),begin=await clock.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)};
    const accepted=await captureNativeClock(f.ctx,{...f.input.command,employmentId:f.input.employmentId});
    await expect(clock.complete(f.ctx,f.input,proof)).rejects.toBeInstanceOf(ClockConflictError);
    expect(await counter(f.input.keyId)).toBe(0);expect((await challenge(begin.challenge.id)).consumedAt).toBeNull();
    expect(await ownNativeClockReceipt(f.ctx,f.input.employmentId,f.input.command.requestId)).toEqual(accepted);
    expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.integrity.checked'))).toHaveLength(0);
    const next={...f.input,command:{...f.input.command,requestId:randomUUID()}},pending=await clock.begin(f.ctx,next);
    await abandonNativeClock(f.ctx,next.employmentId,next.command.requestId);
    await expect(clock.complete(f.ctx,next,{challengeId:pending.challenge.id,assertion:assertion(pending.context,f.privateKey)})).rejects.toBeInstanceOf(ClockConflictError);
    expect(await counter(f.input.keyId)).toBe(0);expect((await challenge(pending.challenge.id)).consumedAt).toBeNull();
    expect(await owner.db.select().from(schema.attendancePunch)).toHaveLength(1);
  });
  it('enforces registered-device policy and refuses credential substitution under an issued challenge',async()=>{
    const f=await fixture();await setAttendancePolicy(adminCtx(base),{...policy(),requireRegisteredDevice:true});
    const begin=await clock.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)};
    await expect(clock.complete(f.ctx,f.input,proof)).rejects.toMatchObject({name:'DeviceNotRegisteredError'});await counts(f,begin.challenge.id);
    const registered=await registerDevice(f.ctx,{employmentId:f.input.employmentId,label:'Signed phone'}),changed={...f.input,deviceToken:registered.deviceToken};
    await expect(clock.complete(f.ctx,changed,proof)).rejects.toMatchObject({reason:'binding_conflict'});
    const next={...changed,command:{...changed.command,requestId:randomUUID()}},pending=await clock.begin(f.ctx,next);
    const receipt=await clock.complete(f.ctx,next,{challengeId:pending.challenge.id,assertion:assertion(pending.context,f.privateKey)});
    const [capture]=await owner.db.select().from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.id,receipt.id));
    expect(capture.deviceId).toBe(registered.deviceId);
    const links=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,receipt.id));
    expect(JSON.stringify(links)).not.toContain(registered.deviceToken);
  });
  it('rolls back an already-written punch when its integrity audit link cannot commit',async()=>{
    const f=await fixture(),begin=await clock.begin(f.ctx,f.input),proof={challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)};
    await owner.db.execute(sql`create function app.test_integrity_link_failure() returns trigger language plpgsql as $$begin
      if new.event_type='attendance.clock.integrity.checked' then raise exception 'synthetic integrity link refusal';end if;return new;end;$$`);
    await owner.db.execute(sql`create trigger zz_test_integrity_link_failure before insert on domain_event for each row execute function app.test_integrity_link_failure()`);
    try{
      const failure=await clock.complete(f.ctx,f.input,proof).then(()=>null,error=>error);
      expect(failure).toBeInstanceOf(Error);let cause=failure;
      for(let depth=0;depth<5&&cause.cause;depth++)cause=cause.cause;
      expect(cause.message).toBe('synthetic integrity link refusal');
      await counts(f,begin.challenge.id);
      expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance.clock.captured'))).toHaveLength(0);
    }finally{
      await owner.db.execute(sql`drop trigger zz_test_integrity_link_failure on domain_event`);
      await owner.db.execute(sql`drop function app.test_integrity_link_failure()`);
    }
    expect((await clock.complete(f.ctx,f.input,proof)).direction).toBe('in');
  });
  it.each(['expiry','employment'] as const)('refuses %s changed while the attendance subject lock is held',async(change)=>{
    const f=await fixture(),input={...f.input,command:{...f.input.command,sampledAt:Date.now()+119000}};let begin=await clock.begin(f.ctx,input);
    if(change==='expiry'){
      const row=await challenge(begin.challenge.id),now=Date.now();
      await owner.db.delete(schema.mobileIntegrityChallenge).where(eq(schema.mobileIntegrityChallenge.id,row.id));
      await owner.db.insert(schema.mobileIntegrityChallenge).values({...row,issuedAt:new Date(now-118000),expiresAt:new Date(now+2000)});
      begin=await clock.begin(f.ctx,input);
    }
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
    const holding=owner.db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${base.tenantId+':'+input.employmentId},0))`);entered();await held;
    });
    try{
      await started;
      const pending=clock.complete(f.ctx,input,{challengeId:begin.challenge.id,assertion:assertion(begin.context,f.privateKey)}),result=Promise.allSettled([pending]);
      try{
        const until=Date.now()+5000;let waiting=false;
        while(Date.now()<until){
          const rows=await owner.db.execute(sql`select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
            and wait_event_type='Lock' and query like '%pg_advisory_xact_lock%'`);
          if(rows.length){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
        }
        expect(waiting).toBe(true);
        if(change==='expiry')await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${begin.challenge.expiresAt}::timestamptz-clock_timestamp())))+0.05)`);
        else await owner.db.update(schema.employment).set({hiredOn:'2099-01-01'}).where(eq(schema.employment.id,input.employmentId));
      }finally{release();}
      await holding;const [outcome]=await result;expect(outcome.status).toBe('rejected');
      if(change==='expiry')expect(outcome).toMatchObject({reason:{reason:'expired'}});
      await counts(f,begin.challenge.id);
    }finally{release();await holding.catch(()=>{});}
  });
});
