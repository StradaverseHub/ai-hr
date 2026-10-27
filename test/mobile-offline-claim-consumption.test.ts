/** Real signatures/SQL/RLS/custody/counters. Vendor preparation and adjudication policy are synthetic.
 * Accepted cases call the canonical offline writer (captureOfflineClockTx); offline readers remain separate work. */
import {createHash,randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as S from '../db/schema';
import {createOfflineClaimService,offlineClaimPhotoAAD,type OfflineClaimPorts} from '../core/mobile-offline-claim';
import {purgeExpiredOfflinePhotos} from '../core/mobile-offline-photo-retention';
import {revokeOwnIntegrityKey} from '../core/mobile-integrity-key';
import {checkInTx,checkOutTx,clockScheduleForTx} from '../core/attendance';
import {createShift} from '../core/roster';
import {captureOfflineClockTx,setAttendancePolicy} from '../packs/attendance/service';
import {withAttendanceTenant} from '../core/module-gate';
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
/** `kept` lists punches that existed before the consumption (an open session); nothing else may remain. */
async function untouched(f:Awaited<ReturnType<typeof offlineServiceFixture>>,kept:string[]=[]){
 expect(await owner.db.select().from(S.mobileOfflineClaim)).toHaveLength(0);expect(await owner.db.select().from(S.mobileOfflinePhoto)).toHaveLength(0);
 expect((await owner.db.select({id:S.attendancePunch.id}).from(S.attendancePunch).orderBy(asc(S.attendancePunch.id))).map(row=>row.id)).toEqual([...kept].sort());
 const [key]=await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)),[stream]=await owner.db.select().from(S.mobileOfflineContext).where(eq(S.mobileOfflineContext.id,f.context.id));
 expect(key.assertionCounter).toBe(0);expect(stream.nextSequence).toBe(1);expect(stream.previousDigest).toBeNull();expect(stream.closedAt).toBeNull();
}
// Canonical punch_at is MYT wall time; milliseconds are written so an exact effectiveAt can be linked.
const mytTime=(at:number)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(at))+'.'+String(at%1000).padStart(3,'0');
/** Accepted instants are whole seconds (0647's capture CHECK, as online punch_at): the first inside the reported
 * interval [issuedAt, issuedAt+1 s]. `settled` waits on the database clock that stamps receipt until it has passed. */
const whole=(f:{context:{issuedAt:number}})=>Math.ceil(f.context.issuedAt/1000)*1000;
async function settled(f:{context:{issuedAt:number}}){
 await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${new Date(whole(f)).toISOString()}::timestamptz-clock_timestamp())))+0.02)`);
 const [row]=await owner.db.execute<{passed:boolean}>(sql`select clock_timestamp()>${new Date(whole(f)).toISOString()}::timestamptz passed`);expect(row.passed).toBe(true);
}
type Adjudication=Parameters<OfflineClaimPorts['adjudicate']>;
/** The canonical offline writer through the attendance facade, as a deterministic policy owner would call it. */
async function accept(tx:Adjudication[0],ctx:Adjudication[1],facts:Adjudication[2],at=whole(facts)){
 const c=facts.claim.command,written=await captureOfflineClockTx(tx,ctx,{employmentId:facts.claim.scope.employmentId,requestId:c.requestId,action:c.action,lat:c.lat,lng:c.lng,accuracy:c.accuracy,effectiveAt:new Date(at),claimDigest:facts.digest});
 if(written.kind!=='recorded')throw new Error('Canonical offline writer refused: '+written.reason);
 expect(written.effectiveAt).toBe(at);return {outcome:'accepted',reason:'clock_accepted',captureId:written.captureId,effectiveAt:at};
}
/** A faulty policy owner bypassing the canonical writer. Its capture states effectiveAt (+captureMs) and its punch is
 * mobile_offline, unless `web` writes the pre-0647 online shape (no effective_at, web punch). `ms` shifts only the
 * punch instant; `days` moves only attendance_date, so days:-1 with ms:0 is the overnight-out encoding. */
async function forged(tx:Adjudication[0],ctx:Adjudication[1],facts:Adjudication[2],written:{ms?:number;days?:number;captureMs?:number;web?:boolean}){
 const at=whole(facts),c=facts.claim.command,punchAt=at+(written.ms??0),date=todayInKualaLumpur(new Date(punchAt+(written.days??0)*86400000)),id=randomUUID();
 const effective=written.web?null:new Date(at+(written.captureMs??0)).toISOString();
 await tx.execute(sql`insert into attendance_clock_capture(id,tenant_id,employment_id,attendance_date,direction,request_id,server_recorded_at,lat,lng,accuracy_m,command_digest,effective_at)
  values(${id}::uuid,${ctx.tenantId}::uuid,${facts.claim.scope.employmentId}::uuid,${date}::date,${c.action},${c.requestId}::uuid,${new Date(facts.receivedAt).toISOString()}::timestamptz,${c.lat},${c.lng},${c.accuracy},${digest(offlineClockClaimClientData(facts.claim))},${effective}::timestamptz)`);
 await (c.action==='in'?checkInTx:checkOutTx)(ctx,{employmentId:facts.claim.scope.employmentId,date,time:mytTime(punchAt),geo:{lat:c.lat,lng:c.lng,accuracy:c.accuracy},clockCaptureId:id,preciseOrder:true,...(written.web?{}:{method:'mobile_offline' as const})},tx);
 return {outcome:'accepted',reason:'clock_accepted',captureId:id,effectiveAt:at};
}
/** Provenance the canonical writer must leave: its capture holds exactly effectiveAt, its punch is mobile_offline. */
async function provenance(captureId:string){
 const [row]=await owner.db.execute<{effectiveMs:string|null;later:boolean|null;method:string}>(sql`select (extract(epoch from c.effective_at)*1000)::bigint::text "effectiveMs",c.server_recorded_at>c.effective_at later,p.method::text method
  from attendance_clock_capture c join attendance_punch p on p.clock_capture_id=c.id where c.id=${captureId}::uuid`);
 return row&&{effectiveAt:row.effectiveMs==null?null:Number(row.effectiveMs),later:row.later,method:row.method};
}
/** A real open overnight session: a rostered midnight-crossing shift on the MYT day before effectiveAt's day
 * (effectiveAt is the fixture's first whole second), checked in at 22:00 by the canonical writer. */
async function overnight(f:Awaited<ReturnType<typeof offlineServiceFixture>>){
 const start=todayInKualaLumpur(new Date(whole(f)-86400000)),shift=await createShift(adminCtx(base),{name:'Offline overnight',code:'OFFLINE_NIGHT',startTime:'22:00',endTime:'06:00'});
 await owner.db.insert(S.rosterAssignment).values({tenantId:base.tenantId,employmentId:f.e.employmentId,shiftDate:start,shiftId:shift.id});
 await withAttendanceTenant(f.ctx,tx=>checkInTx(f.ctx,{employmentId:f.e.employmentId,date:start,time:'22:00:00',geo:{lat:3,lng:101,accuracy:5}},tx));
 // Non-vacuous: the start day is the previous MYT day, its schedule crosses midnight and its session is open.
 expect(start).not.toBe(todayInKualaLumpur(new Date(whole(f))));expect((await withAttendanceTenant(f.ctx,tx=>clockScheduleForTx(tx,f.e.employmentId,start))).crossesMidnight).toBe(true);
 const punches=await owner.db.select().from(S.attendancePunch);expect(punches).toMatchObject([{attendanceDate:start,direction:'in',punchAt:'22:00:00',voidedAt:null}]);
 expect(await owner.db.select({checkIn:S.attendance.checkInAt,checkOut:S.attendance.checkOutAt}).from(S.attendance).where(and(eq(S.attendance.employmentId,f.e.employmentId),eq(S.attendance.attendanceDate,start)))).toEqual([{checkIn:'22:00:00',checkOut:null}]);
 return {start,kept:[punches[0].id]};
}
/** Readers' reconstruction, independent of the service: the punch's instant is (attendance_date + days) + punch_at in MYT. */
async function instant(punchId:string,days:0|1,at:number){
 const [row]=await owner.db.execute<{exact:boolean}>(sql`select timezone('Asia/Kuala_Lumpur',attendance_date+${days}::int+punch_at)=${new Date(at).toISOString()}::timestamptz exact from attendance_punch where id=${punchId}::uuid`);return row?.exact;
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
  await policy();const f=await offlineServiceFixture(base),c=consumer();await settled(f);c.adjudicate.mockImplementation((tx,ctx,facts)=>accept(tx,ctx,facts));c.beforeCommit.mockRejectedValueOnce(new Error('rollout disabled'));
  await expect(c.service().consume(f.ctx,f.signed())).rejects.toThrow('rollout disabled');await untouched(f);expect(await owner.db.select().from(S.attendanceClockCapture)).toHaveLength(0);
  expect(await owner.db.select().from(S.domainEvent).where(eq(S.domainEvent.eventType,'mobile.offline.claim.processed'))).toHaveLength(0);
 });
 it('links an accepted out-first command to the actual canonical punch, with effective bounds separate from admission',async()=>{
  await policy();const f=await offlineServiceFixture(base),c=consumer();await settled(f);c.adjudicate.mockImplementation((tx,ctx,facts)=>accept(tx,ctx,facts));const result=await c.service().consume(f.ctx,f.signed());
  expect(result).toMatchObject({outcome:'accepted',reason:'clock_accepted',effectiveAt:whole(f),effectiveMinimum:f.context.issuedAt});expect(result.receivedAt).toBeGreaterThanOrEqual(result.effectiveAt!);
  expect(await owner.db.select().from(S.attendancePunch).where(eq(S.attendancePunch.clockCaptureId,result.captureId!))).toHaveLength(1);
  expect(await provenance(result.captureId!)).toEqual({effectiveAt:whole(f),later:true,method:'mobile_offline'});
  expect((await owner.db.select().from(S.mobileOfflineClaim))[0].effectiveAt?.getTime()).toBe(whole(f));
 });
 // The last two shapes pass every instant/day check; only the 0647 provenance requirement refuses them.
 it.each([['recorded one millisecond after',{ms:1}],['recorded on the next attendance day from',{days:1}],['captured one second before',{captureMs:-1000}],['written as an online web punch at',{web:true}]] as const)('rolls back everything when the linked punch is %s effectiveAt, and accepts the exact instant',async(_label,written)=>{
  await policy();const f=await offlineServiceFixture(base),c=consumer();await settled(f);c.adjudicate.mockImplementation((tx,ctx,facts)=>forged(tx,ctx,facts,written));
  await expect(c.service().consume(f.ctx,f.signed())).rejects.toMatchObject({reason:'configuration_unavailable'});expect(c.adjudicate).toHaveBeenCalledOnce();
  await untouched(f);expect(await owner.db.select().from(S.attendanceClockCapture)).toHaveLength(0);expect(await owner.db.select().from(S.attendance).where(eq(S.attendance.employmentId,f.e.employmentId))).toHaveLength(0);
  expect(await owner.db.select().from(S.domainEvent).where(eq(S.domainEvent.eventType,'mobile.offline.claim.processed'))).toHaveLength(0);
  c.adjudicate.mockImplementation((tx,ctx,facts)=>accept(tx,ctx,facts));const result=await c.service().consume(f.ctx,f.signed());
  expect(result).toMatchObject({outcome:'accepted',reason:'clock_accepted',effectiveAt:whole(f)});
  const [punch]=await owner.db.select().from(S.attendancePunch).where(eq(S.attendancePunch.clockCaptureId,result.captureId!));expect(punch.attendanceDate).toBe(todayInKualaLumpur(new Date(result.effectiveAt!)));
  expect(await instant(punch.id,0,result.effectiveAt!)).toBe(true);expect(await provenance(result.captureId!)).toEqual({effectiveAt:whole(f),later:true,method:'mobile_offline'});
 });
 // Owner decision 2026-10-28: an offline overnight out belongs to the open session's start day, as the online writer files it.
 it.each([['one millisecond after',{ms:1,days:-1}],['on the day before the session start',{days:-2}],['on effectiveAt\'s own day instead of the open session start day',{days:0}]] as const)('rolls back an overnight out recorded %s, and accepts the start-day encoding of the exact instant',async(_label,written)=>{
  await policy();const f=await offlineServiceFixture(base),{start,kept}=await overnight(f),c=consumer();await settled(f);c.adjudicate.mockImplementation((tx,ctx,facts)=>forged(tx,ctx,facts,written));
  await expect(c.service().consume(f.ctx,f.signed())).rejects.toMatchObject({reason:'configuration_unavailable'});expect(c.adjudicate).toHaveBeenCalledOnce();
  await untouched(f,kept);expect(await owner.db.select().from(S.attendanceClockCapture)).toHaveLength(0);
  expect(await owner.db.select({date:S.attendance.attendanceDate,checkOut:S.attendance.checkOutAt}).from(S.attendance).where(eq(S.attendance.employmentId,f.e.employmentId))).toEqual([{date:start,checkOut:null}]);
  expect(await owner.db.select().from(S.domainEvent).where(eq(S.domainEvent.eventType,'mobile.offline.claim.processed'))).toHaveLength(0);
  // The canonical writer itself files the overnight out on the start day; no caller supplies the encoding.
  c.adjudicate.mockImplementation((tx,ctx,facts)=>accept(tx,ctx,facts));const result=await c.service().consume(f.ctx,f.signed());
  expect(result).toMatchObject({outcome:'accepted',reason:'clock_accepted',effectiveAt:whole(f)});expect(todayInKualaLumpur(new Date(result.effectiveAt!))).not.toBe(start);
  const [punch]=await owner.db.select().from(S.attendancePunch).where(eq(S.attendancePunch.clockCaptureId,result.captureId!));
  expect(punch).toMatchObject({attendanceDate:start,direction:'out',voidedAt:null});expect(await instant(punch.id,1,result.effectiveAt!)).toBe(true);
  expect(await owner.db.select({date:S.attendance.attendanceDate}).from(S.attendance).where(eq(S.attendance.employmentId,f.e.employmentId))).toEqual([{date:start}]);
 });
 it('rolls back an in punch filed on the prior day even while an overnight session is open, and accepts it on its own day',async()=>{
  await policy();const f=await offlineServiceFixture(base),{start,kept}=await overnight(f),c=consumer(),claim={...f.claim,command:{...f.claim.command,action:'in' as const}};await settled(f);
  c.adjudicate.mockImplementation((tx,ctx,facts)=>forged(tx,ctx,facts,{days:-1}));
  await expect(c.service().consume(f.ctx,f.signed(claim))).rejects.toMatchObject({reason:'configuration_unavailable'});expect(c.adjudicate).toHaveBeenCalledOnce();
  await untouched(f,kept);expect(await owner.db.select().from(S.attendanceClockCapture)).toHaveLength(0);
  c.adjudicate.mockImplementation((tx,ctx,facts)=>accept(tx,ctx,facts));const result=await c.service().consume(f.ctx,f.signed(claim));
  expect(result).toMatchObject({outcome:'accepted',reason:'clock_accepted',effectiveAt:whole(f)});
  const [punch]=await owner.db.select().from(S.attendancePunch).where(eq(S.attendancePunch.clockCaptureId,result.captureId!));
  expect(punch).toMatchObject({attendanceDate:todayInKualaLumpur(new Date(result.effectiveAt!)),direction:'in',voidedAt:null});expect(punch.attendanceDate).not.toBe(start);expect(await instant(punch.id,0,result.effectiveAt!)).toBe(true);
 });
 it('refuses a request ID an attendance capture already holds before policy runs, with a stable terminal receipt',async()=>{
  await policy();const f=await offlineServiceFixture(base),c=consumer(),requestId=f.claim.command.requestId;c.adjudicate.mockImplementation((tx,ctx,facts)=>accept(tx,ctx,facts));
  await owner.db.insert(S.attendanceClockCapture).values({tenantId:base.tenantId,employmentId:f.e.employmentId,attendanceDate:todayInKualaLumpur(),direction:'in',requestId,serverRecordedAt:new Date(),commandDigest:'c'.repeat(64)});
  expect(await owner.db.select().from(S.attendanceClockCapture).where(eq(S.attendanceClockCapture.requestId,requestId))).toHaveLength(1);
  const result=await c.service().consume(f.ctx,f.signed());
  expect(result).toMatchObject({outcome:'refused',reason:'request_conflict',requestId,captureId:null,effectiveAt:null,digest:digest(offlineClockClaimClientData(f.claim))});
  expect(c.adjudicate).not.toHaveBeenCalled();expect(c.fresh).toHaveBeenCalledTimes(2);expect(c.beforeCommit).toHaveBeenCalledOnce();expect(c.beforeCommit.mock.calls[0][3]).toEqual({outcome:'refused',reason:'request_conflict'});
  expect(await owner.db.select().from(S.mobileOfflineClaim)).toMatchObject([{id:result.id,requestId,outcome:'refused',reason:'request_conflict',captureId:null,effectiveAt:null}]);
  expect((await owner.db.select().from(S.mobileOfflineContext))[0]).toMatchObject({nextSequence:2,previousDigest:result.digest,closedAt:null});
  expect((await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,f.key.id)))[0].assertionCounter).toBe(1);
  const events=await owner.db.select().from(S.domainEvent).where(and(eq(S.domainEvent.eventType,'mobile.offline.claim.processed'),eq(S.domainEvent.aggregateId,result.id)));
  expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({outcome:'refused',reason:'request_conflict'});
  expect(await c.service().consume(f.ctx,f.signed())).toEqual(result);expect(c.adjudicate).not.toHaveBeenCalled();
  expect(await owner.db.select().from(S.attendancePunch)).toHaveLength(0);expect(await owner.db.select().from(S.attendanceClockCapture)).toHaveLength(1);
 });
 it.each(['unknown','outside'] as const)('cannot turn %s timing into accepted attendance even if a callback tries',async mode=>{
  await policy();const f=await offlineServiceFixture(base),c=consumer(),claim=mode==='unknown'?{...f.claim,time:{...f.claim.time,elapsed:{status:'unknown' as const,reason:'continuity_unknown' as const}}}:f.claim;await settled(f);
  // The canonical writer records either instant; only the service's bounds owner refuses it, rolling the write back.
  c.adjudicate.mockImplementation((tx,ctx,facts)=>accept(tx,ctx,facts,mode==='outside'?whole(f)-60000:whole(f)));
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
 it('retains the exact owned image before acknowledging review, even if the caller or policy owner later changes its buffer',async()=>{
  const f=await offlineServiceFixture(base),c=consumer(),original=Buffer.from('original retained image'),bytes=Buffer.from(original),claim={...f.claim,command:{...f.claim.command,photo:{sha256:digest(original),byteLength:original.length,mimeType:'image/jpeg' as const}}};
  // Zeroes the received buffer after the post-adjudication photo check, during the custody writes.
  c.adjudicate.mockImplementationOnce(async(_tx,_ctx,_facts,photo)=>{setImmediate(()=>photo?.bytes.fill(0));return {outcome:'needs_review',reason:'review_required'};});
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
 it('lets a group admin read and purge only expired photos, never retained ciphertext, keeping stable receipts',async()=>{
  const f=await offlineServiceFixture(base),c=consumer(),kept=Buffer.from('retained for an hour'),short=Buffer.from('short test retention'),jpeg='image/jpeg' as const;
  const photoOf=(bytes:Buffer)=>({sha256:digest(bytes),byteLength:bytes.length,mimeType:jpeg});
  const ids=(rows:{claimId:string}[])=>rows.map(row=>row.claimId),custody=async()=>ids(await owner.db.select({claimId:S.mobileOfflinePhoto.claimId}).from(S.mobileOfflinePhoto).orderBy(asc(S.mobileOfflinePhoto.retainedUntil),asc(S.mobileOfflinePhoto.claimId)));
  // Application role under tenant context and RLS, not the owner connection.
  const visible=async(ctx:typeof f.ctx)=>ids(await withAttendanceTenant(ctx,tx=>tx.select({claimId:S.mobileOfflinePhoto.claimId}).from(S.mobileOfflinePhoto).orderBy(asc(S.mobileOfflinePhoto.retainedUntil),asc(S.mobileOfflinePhoto.claimId))));
  const firstClaim={...f.claim,command:{...f.claim.command,photo:photoOf(kept)}},first=await c.service().consume(f.ctx,f.signed(firstClaim),{bytes:kept,mimeType:jpeg});
  // Non-vacuous: the unexpired custody row exists and its actor still reads it; the group admin does not.
  expect(first.photo!.retainedUntil-first.receivedAt).toBeGreaterThanOrEqual(3600000-60000);expect(await custody()).toEqual([first.id]);expect(await visible(f.ctx)).toEqual([first.id]);expect(await visible(adminCtx(base))).toEqual([]);
  expect(await withAttendanceTenant(adminCtx(base),tx=>tx.delete(S.mobileOfflinePhoto).where(eq(S.mobileOfflinePhoto.claimId,first.id)).returning({claimId:S.mobileOfflinePhoto.claimId}))).toEqual([]);
  expect(await purgeExpiredOfflinePhotos(adminCtx(base))).toEqual({purged:0});await expect(purgeExpiredOfflinePhotos(f.ctx)).rejects.toThrow('Only a group administrator');expect(await custody()).toEqual([first.id]);
  const secondClaim={...f.claim,permit:f.context.permits[1],chain:{sequence:2,previousSha256:first.digest},command:{...f.claim.command,requestId:randomUUID(),photo:photoOf(short)}};
  c.config.photoRetentionMs=5000;const second=await c.service().consume(f.ctx,f.signed(secondClaim),{bytes:short,mimeType:jpeg});
  // Expiry is read from the database clock that the policy, delete trigger and purge all use.
  await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${new Date(second.photo!.retainedUntil).toISOString()}::timestamptz-clock_timestamp())))+0.02)`);
  expect(await custody()).toEqual([second.id,first.id]);expect(await visible(f.ctx)).toEqual([second.id,first.id]);expect(await visible(adminCtx(base))).toEqual([second.id]);
  expect(await purgeExpiredOfflinePhotos(adminCtx(base))).toEqual({purged:1});expect(await custody()).toEqual([first.id]);expect(await visible(adminCtx(base))).toEqual([]);
  expect(await c.service().consume(f.ctx,f.signed(secondClaim))).toEqual(second);expect(await c.service().consume(f.ctx,f.signed(firstClaim))).toEqual(first);
  const purged=await owner.db.select({aggregateId:S.domainEvent.aggregateId}).from(S.domainEvent).where(eq(S.domainEvent.eventType,'mobile.offline.photo.purged'));expect(purged).toEqual([{aggregateId:second.id}]);
 });
 it('requires all current verification/adjudication guards and explicit photo retention configuration',()=>{
  const c=consumer();expect(()=>createOfflineClaimService(c.config,{prepare:c.prepare,adjudicate:c.adjudicate} as never)).toThrow();expect(()=>createOfflineClaimService({...c.config,photoRetentionMs:0},c.ports)).toThrow();
 });
});
