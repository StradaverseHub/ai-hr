/** Real signatures/SQL/RLS/custody/counters. Vendor preparation and adjudication policy are synthetic.
 * Accepted cases call the existing canonical writer; offline provenance/readers remain separate work. */
import {createHash,randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant} from '../db/client';
import * as S from '../db/schema';
import {createOfflineClaimService,offlineClaimPhotoAAD,type OfflineClaimPorts} from '../core/mobile-offline-claim';
import {purgeExpiredOfflinePhotos} from '../core/mobile-offline-photo-retention';
import {revokeOwnIntegrityKey} from '../core/mobile-integrity-key';
import {checkOutTx} from '../core/attendance';
import {setAttendancePolicy} from '../packs/attendance/service';
import {decryptSecret} from '../lib/ai/crypto';
import {offlineClockClaimClientData} from '../lib/mobile-offline-clock';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,owner,resetDb,seedBase,type Base} from './harness';
import {offlineServiceFixture} from './helpers/mobile-offline-service-fixture';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
let base:Base,restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-consumption-fixture-secret-2026');await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();await restoreCustody?.();}finally{vi.unstubAllEnvs();await closeAll();}});
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function consumer(){
 const fresh=vi.fn(async()=>{}),prepare=vi.fn<OfflineClaimPorts['prepare']>(async()=>({assertFresh:fresh})),adjudicate=vi.fn<OfflineClaimPorts['adjudicate']>(async()=>({outcome:'needs_review',reason:'review_required'})),beforeCommit=vi.fn<OfflineClaimPorts['beforeCommit']>(async()=>{}),ports={prepare,adjudicate,beforeCommit};
 const config={apiOrigin:'https://hr.example.com',photoRetentionMs:3600000};return {fresh,prepare,adjudicate,beforeCommit,ports,config,service:()=>createOfflineClaimService(config,ports)};
}
async function untouched(f:Awaited<ReturnType<typeof offlineServiceFixture>>){
 expect(await owner.db.select().from(S.mobileOfflineClaim)).toHaveLength(0);expect(await owner.db.select().from(S.mobileOfflinePhoto)).toHaveLength(0);expect(await owner.db.select().from(S.attendancePunch)).toHaveLength(0);
 const [key]=await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)),[stream]=await owner.db.select().from(S.mobileOfflineContext).where(eq(S.mobileOfflineContext.id,f.context.id));
 expect(key.assertionCounter).toBe(0);expect(stream.nextSequence).toBe(1);expect(stream.previousDigest).toBeNull();expect(stream.closedAt).toBeNull();
}
async function accept(tx:Parameters<OfflineClaimPorts['adjudicate']>[0],ctx:Parameters<OfflineClaimPorts['adjudicate']>[1],facts:Parameters<OfflineClaimPorts['adjudicate']>[2],at=facts.bounds.status==='reported_interval'?facts.bounds.minimum:facts.context.issuedAt){
 const date=todayInKualaLumpur(new Date(at)),time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(at));
 const [capture]=await tx.insert(S.attendanceClockCapture).values({tenantId:ctx.tenantId,employmentId:facts.claim.scope.employmentId,attendanceDate:date,direction:facts.claim.command.action,requestId:facts.claim.command.requestId,serverRecordedAt:new Date(facts.receivedAt),lat:facts.claim.command.lat,lng:facts.claim.command.lng,accuracyM:facts.claim.command.accuracy,commandDigest:digest(offlineClockClaimClientData(facts.claim))}).returning();
 await checkOutTx(ctx,{employmentId:facts.claim.scope.employmentId,date,time,geo:{lat:facts.claim.command.lat,lng:facts.claim.command.lng,accuracy:facts.claim.command.accuracy},clockCaptureId:capture.id,preciseOrder:true},tx);
 return {outcome:'accepted',reason:'clock_accepted',captureId:capture.id,effectiveAt:at};
}
async function policy(){await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});}
describe('ordered transactional offline claim consumption',()=>{
 it.each(['ios','android'] as const)('stores one %s review receipt across concurrent retries and retains exact encrypted proof bytes',async platform=>{
  const f=await offlineServiceFixture(base,platform),c=consumer(),signed=f.signed(),[a,b]=await Promise.all([c.service().consume(f.ctx,signed),c.service().consume(f.ctx,signed)]);
  expect(a).toEqual(b);expect(a).toMatchObject({outcome:'needs_review',reason:'review_required',captureId:null,effectiveAt:null,digest:digest(offlineClockClaimClientData(f.claim))});expect(c.adjudicate).toHaveBeenCalledOnce();
  const [row]=await owner.db.select().from(S.mobileOfflineClaim),aad=JSON.stringify(['mobile-offline-claim',1,row.tenantId,row.actorId,row.id,row.contextId,row.requestId]);
  expect(JSON.parse(decryptSecret(row.claimCiphertext,aad))).toEqual(signed);expect(row.claimCiphertext).not.toContain('attendance.clock');expect(row.assertionCounter).toBe(platform==='ios'?1:null);
  expect((await owner.db.select().from(S.mobileOfflineContext))[0]).toMatchObject({nextSequence:2,previousDigest:a.digest,closedAt:null});expect(await owner.db.select().from(S.attendancePunch)).toHaveLength(0);
  const [event]=await owner.db.select().from(S.domainEvent).where(eq(S.domainEvent.eventType,'mobile.offline.claim.processed'));const payload=event.payload;if(!payload||typeof payload!=='object')throw Error('Missing audit payload');
  expect(Object.keys(payload).sort()).toEqual(['contextId','keyId','outcome','reason','sequence']);expect(JSON.stringify(payload)).not.toContain('signature');
 });
 it.each(['ios','android'] as const)('preserves %s proof order and automatically closes only an exhausted inventory',async platform=>{
  const f=await offlineServiceFixture(base,platform),c=consumer(),first=await c.service().consume(f.ctx,f.signed());
  const next={...f.claim,permit:f.context.permits[1],chain:{sequence:2,previousSha256:first.digest},command:{...f.claim.command,requestId:randomUUID()}};
  c.adjudicate.mockResolvedValueOnce({outcome:'refused',reason:'policy_changed'});const second=await c.service().consume(f.ctx,f.signed(next));expect(second.outcome).toBe('refused');
  expect((await owner.db.select().from(S.mobileOfflineContext))[0]).toMatchObject({nextSequence:3,previousDigest:second.digest,closeReason:'exhausted',closeRequestId:next.command.requestId});
  expect((await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)))[0].assertionCounter).toBe(platform==='ios'?2:0);expect(await owner.db.select().from(S.attendancePunch)).toHaveLength(0);
  expect(await c.service().consume(f.ctx,f.signed())).toEqual(first);
 });
 it('rejects missing predecessors and invalid signatures before spending a provider request',async()=>{
  const f=await offlineServiceFixture(base),c=consumer(),later={...f.claim,permit:f.context.permits[1],chain:{sequence:2,previousSha256:'d'.repeat(64)}};
  await expect(c.service().consume(f.ctx,f.signed(later))).rejects.toMatchObject({reason:'chain_conflict'});
  const signed=f.signed();await expect(c.service().consume(f.ctx,{...signed,claim:{...f.claim,command:{...f.claim.command,lat:4}}})).rejects.toMatchObject({reason:'invalid_proof'});
  expect(c.prepare).not.toHaveBeenCalled();await untouched(f);
 });
 it('recovers exact receipts after key revocation, provider outage and loss of encryption configuration',async()=>{
  const f=await offlineServiceFixture(base),c=consumer(),first=await c.service().consume(f.ctx,f.signed());await revokeOwnIntegrityKey(f.ctx,{employmentId:f.e.employmentId,keyId:f.key.id});
  c.prepare.mockClear();c.prepare.mockRejectedValue(new Error('provider down'));vi.stubEnv('AI_CONFIG_SECRET','');
  expect(await c.service().consume(f.ctx,f.signed())).toEqual(first);expect(c.prepare).not.toHaveBeenCalled();expect(c.adjudicate).toHaveBeenCalledOnce();
  await expect(c.service().consume(f.ctx,f.signed({...f.claim,command:{...f.claim.command,lat:4}}))).rejects.toMatchObject({reason:'binding_conflict'});
 });
 it('refuses another actor, tenant or employment without exposing a receipt or invoking provider work',async()=>{
  const f=await offlineServiceFixture(base),peer=await offlineServiceFixture(base),c=consumer();await c.service().consume(f.ctx,f.signed());c.prepare.mockClear();
  await expect(c.service().consume(peer.ctx,f.signed())).rejects.toMatchObject({reason:'scope_unavailable'});
  await expect(c.service().consume({...f.ctx,tenantId:randomUUID()},f.signed())).rejects.toThrow();
  await expect(c.service().consume(f.ctx,f.signed({...f.claim,scope:{...f.claim.scope,employmentId:peer.e.employmentId},command:{...f.claim.command,requestId:randomUUID()}}))).rejects.toThrow();expect(c.prepare).not.toHaveBeenCalled();
 });
 it('preserves retryability on provider outage and repeats freshness checks inside the commit transaction',async()=>{
  const f=await offlineServiceFixture(base,'android'),c=consumer();c.prepare.mockRejectedValueOnce(new Error('provider down'));await expect(c.service().consume(f.ctx,f.signed())).rejects.toThrow('provider down');await untouched(f);
  let calls=0;c.fresh.mockImplementation(async()=>{if(++calls===2)throw Error('expired before commit');});await expect(c.service().consume(f.ctx,f.signed())).rejects.toThrow('expired before commit');await untouched(f);
  c.fresh.mockResolvedValue();expect((await c.service().consume(f.ctx,f.signed())).outcome).toBe('needs_review');
 });
 it('rolls back counter, cursor, canonical punch/capture, claim and audit if the final guard refuses',async()=>{
  await policy();const f=await offlineServiceFixture(base),c=consumer();c.adjudicate.mockImplementation((tx,ctx,facts)=>accept(tx,ctx,facts));c.beforeCommit.mockRejectedValueOnce(new Error('rollout disabled'));
  await expect(c.service().consume(f.ctx,f.signed())).rejects.toThrow('rollout disabled');await untouched(f);expect(await owner.db.select().from(S.attendanceClockCapture)).toHaveLength(0);
  expect(await owner.db.select().from(S.domainEvent).where(eq(S.domainEvent.eventType,'mobile.offline.claim.processed'))).toHaveLength(0);
 });
 it('links an accepted out-first command to the actual canonical punch, with effective bounds separate from admission',async()=>{
  await policy();const f=await offlineServiceFixture(base),c=consumer();c.adjudicate.mockImplementation((tx,ctx,facts)=>accept(tx,ctx,facts));const result=await c.service().consume(f.ctx,f.signed());
  expect(result).toMatchObject({outcome:'accepted',reason:'clock_accepted',effectiveAt:f.context.issuedAt,effectiveMinimum:f.context.issuedAt});expect(result.receivedAt).toBeGreaterThanOrEqual(result.effectiveAt!);
  expect(await owner.db.select().from(S.attendancePunch).where(eq(S.attendancePunch.clockCaptureId,result.captureId!))).toHaveLength(1);
 });
 it.each(['unknown','outside'] as const)('cannot turn %s timing into accepted attendance even if a callback tries',async mode=>{
  await policy();const f=await offlineServiceFixture(base),c=consumer(),claim=mode==='unknown'?{...f.claim,time:{...f.claim.time,elapsed:{status:'unknown' as const,reason:'continuity_unknown' as const}}}:f.claim;
  c.adjudicate.mockImplementation((tx,ctx,facts)=>accept(tx,ctx,facts,mode==='outside'?f.context.issuedAt-60000:f.context.issuedAt));
  await expect(c.service().consume(f.ctx,f.signed(claim))).rejects.toMatchObject({reason:'configuration_unavailable'});await untouched(f);
 });
 it('refuses acceptance without a linked canonical punch and refuses unknown decision authority fields',async()=>{
  const f=await offlineServiceFixture(base),c=consumer();
  for(const result of [{outcome:'accepted',reason:'clock_accepted',captureId:randomUUID(),effectiveAt:f.context.issuedAt},{outcome:'needs_review',reason:'review_required',verified:true}]){
   c.adjudicate.mockResolvedValueOnce(result);await expect(c.service().consume(f.ctx,f.signed())).rejects.toMatchObject({reason:'configuration_unavailable'});await untouched(f);
  }
 });
 it('detects mutation of verified command facts and rolls back tentative business effects',async()=>{
  const f=await offlineServiceFixture(base),c=consumer();c.adjudicate.mockImplementationOnce(async(tx,ctx,facts)=>{await tx.update(S.person).set({fullName:'must roll back'}).where(eq(S.person.id,ctx.personId!));facts.claim.command.lat=4;return {outcome:'needs_review',reason:'review_required'};});
  await expect(c.service().consume(f.ctx,f.signed())).rejects.toMatchObject({reason:'binding_conflict'});await untouched(f);
  expect((await owner.db.select().from(S.person).where(eq(S.person.id,f.e.personId)))[0].fullName).toBe('Offline consumer employee');
 });
 it('retains the exact owned image before acknowledging review, even if the caller changes its buffer',async()=>{
  const f=await offlineServiceFixture(base),c=consumer(),original=Buffer.from('original retained image'),bytes=Buffer.from(original),claim={...f.claim,command:{...f.claim.command,photo:{sha256:digest(original),byteLength:original.length,mimeType:'image/jpeg' as const}}};
  const pending=c.service().consume(f.ctx,f.signed(claim),{bytes,mimeType:'image/jpeg'});bytes.fill(0);const result=await pending;
  const [media]=await owner.db.select().from(S.mobileOfflinePhoto);expect(Buffer.from(decryptSecret(media.photoCiphertext,offlineClaimPhotoAAD(media)),'base64')).toEqual(original);
  expect(result.photo).toEqual({sha256:digest(original),retainedUntil:media.retainedUntil.getTime()});expect(media.photoCiphertext).not.toContain(original.toString());
  await expect(c.service().consume(f.ctx,f.signed(claim))).resolves.toEqual(result);
 });
 it('refuses missing, changed or unrelated photos before provider work, retaining the original pending stream',async()=>{
  const f=await offlineServiceFixture(base),c=consumer(),bytes=Buffer.from('original'),claim={...f.claim,command:{...f.claim.command,photo:{sha256:digest(bytes),byteLength:bytes.length,mimeType:'image/jpeg' as const}}};
  await expect(c.service().consume(f.ctx,f.signed(claim))).rejects.toMatchObject({reason:'attachment_mismatch'});
  await expect(c.service().consume(f.ctx,f.signed(claim),{bytes:Buffer.from('changed!'),mimeType:'image/jpeg'})).rejects.toMatchObject({reason:'attachment_mismatch'});
  await expect(c.service().consume(f.ctx,f.signed(),{bytes,mimeType:'image/jpeg'})).rejects.toMatchObject({reason:'attachment_mismatch'});expect(c.prepare).not.toHaveBeenCalled();await untouched(f);
 });
 it('rolls back raw photo custody with the claim when commit policy fails',async()=>{
  const f=await offlineServiceFixture(base),c=consumer(),bytes=Buffer.from('retained only on commit'),claim={...f.claim,command:{...f.claim.command,photo:{sha256:digest(bytes),byteLength:bytes.length,mimeType:'image/jpeg' as const}}};
  c.beforeCommit.mockRejectedValueOnce(new Error('policy changed'));await expect(c.service().consume(f.ctx,f.signed(claim),{bytes,mimeType:'image/jpeg'})).rejects.toThrow('policy changed');await untouched(f);
 });
 it('purges only expired tenant photos under group-admin authority, retaining the stable claim receipt',async()=>{
  const f=await offlineServiceFixture(base),c=consumer(),bytes=Buffer.from('short test retention'),claim={...f.claim,command:{...f.claim.command,photo:{sha256:digest(bytes),byteLength:bytes.length,mimeType:'image/jpeg' as const}}};c.config.photoRetentionMs=1000;
  const result=await c.service().consume(f.ctx,f.signed(claim),{bytes,mimeType:'image/jpeg'});expect(await purgeExpiredOfflinePhotos(adminCtx(base))).toEqual({purged:0});
  await expect(purgeExpiredOfflinePhotos(f.ctx)).rejects.toThrow('Only a group administrator');
  await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${new Date(result.photo!.retainedUntil).toISOString()}::timestamptz-clock_timestamp())))+0.02)`);
  const a=await purgeExpiredOfflinePhotos(adminCtx(base));expect(a).toEqual({purged:1});expect(await owner.db.select().from(S.mobileOfflinePhoto)).toHaveLength(0);expect(await c.service().consume(f.ctx,f.signed(claim))).toEqual(result);
  expect(await owner.db.select().from(S.domainEvent).where(and(eq(S.domainEvent.eventType,'mobile.offline.photo.purged'),eq(S.domainEvent.aggregateId,result.id)))).toHaveLength(1);
 });
 it('requires all current verification/adjudication guards and explicit photo retention configuration',()=>{
  const c=consumer();expect(()=>createOfflineClaimService(c.config,{prepare:c.prepare,adjudicate:c.adjudicate} as never)).toThrow();expect(()=>createOfflineClaimService({...c.config,photoRetentionMs:0},c.ports)).toThrow();
 });
});
