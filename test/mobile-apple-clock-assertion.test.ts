/** Synthetic enrollment, real signatures, database locks, counters and transaction rollback. */
import {createHash,generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import cbor from 'cbor';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createAppleEnrollmentService,revokeOwnIntegrityKey} from '../core/mobile-apple-enrollment';
import {createAppleClockAssertionService} from '../core/mobile-apple-clock-assertion';
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
