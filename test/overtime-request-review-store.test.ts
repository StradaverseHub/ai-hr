/** ADR-0151 wave 1b: the person's OWN overtime request through the generic own-review store (migration 0671).
 * Real migrated database and the real native attendance request service; fictional fixtures only.
 * Authored UNRUN (tests run on GitHub Actions under the owner's policy). */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {requestAttendanceCorrection,requestAttendanceCorrectionTx} from '../packs/attendance/service';
import {overtimeRequestReviews as reviews,readOvertimeRequestChoices} from '../core/assistant-actions/overtime-request-review-store';
import {readCompletedNativeOutcomeTx} from '../core/assistant-actions/completed-outcome-readers';
import {OWN_OVERTIME_REQUEST_ACTION as action} from '../lib/assistant-actions/own-overtime-request-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,ctx:SessionContext,subject:{employmentId:string;personId:string};
/** HR calendar days from the repository's HR date owner; a planned overtime date is in the future. */
function calendarDate(offset:number){const value=new Date(todayInKualaLumpur()+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+offset);return value.toISOString().slice(0,10);}
const hiredOn=()=>`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`;
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
const hire=(name:string,base:Base=b)=>hireEmployee({...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]},{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:hiredOn()});
async function login(personId:string,role:'employee'|'hr_admin'='employee',base:Base=b):Promise<SessionContext>{
 const userId=await createAppUser(base.tenantId,personId,role);await grantAssistant({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]},{appUserId:userId});
 return {...await entitledCtx(base,[role]),userId,personId,grants:[{role,companyId:null}]};
}
beforeAll(async()=>{await migrateTestDb();const [installed]=await owner.db.execute<{ok:boolean}>(sql`select app._assistant_generic_review_subject_kind('attendance.overtime.request')='employment' as ok`);expect(installed.ok,'Migration 0671 must be installed.').toBe(true);});
afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-overtime-request-custody-key-1234');
 await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'attendance','active');
 subject=await hire('Fictional Overtime Requester');ctx=await login(subject.personId);
});
const human=(extra:Record<string,unknown>={})=>({action,contractVersion:1 as const,employmentId:subject.employmentId,date:calendarDate(7),plannedStartTime:'18:00',plannedEndTime:'20:00',reason:'Fictional release preparation',remark:'Fictional optional note',...extra});
/** The same overtime-only native input the adapter derives, for "done elsewhere" fixtures. */
const nativeInput=(date=calendarDate(7))=>({employmentId:subject.employmentId,date,plannedStartTime:'18:00',plannedEndTime:'20:00',requestedOtMinutes:120,reason:'Fictional release preparation elsewhere',requestKind:'self_overtime' as const});
const prepare=async(who=ctx,value:unknown=human())=>(await reviews.prepare(who,value)).review;
const confirm=(r:{actionId:string;reviewedDigest:string},who=ctx)=>reviews.confirm(who,{actionId:r.actionId,reviewedDigest:r.reviewedDigest});
async function state(){return{
 requests:await owner.db.select({id:schema.attendanceCorrection.id,status:schema.attendanceCorrection.status,requestedOtMinutes:schema.attendanceCorrection.requestedOtMinutes,plannedStartTime:schema.attendanceCorrection.plannedStartTime,plannedEndTime:schema.attendanceCorrection.plannedEndTime,cancelledAt:schema.attendanceCorrection.cancelledAt}).from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.tenantId,b.tenantId)).orderBy(schema.attendanceCorrection.id),
 requested:await owner.db.select({id:schema.domainEvent.id,actorId:schema.domainEvent.actorId,aggregateId:schema.domainEvent.aggregateId,subjectEmploymentId:schema.domainEvent.subjectEmploymentId}).from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'attendance-correction.requested'))).orderBy(schema.domainEvent.id)};}
async function custody(id:string){const [row]=await owner.db.execute(sql`select r.action_kind,r.state,r.person_id,r.employment_id,r.receipt_subject_kind,r.receipt_subject_id,r.receipt_event_id,r.intent_digest,r.reviewed_digest,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}

describe('ADR-0151 own overtime request custody',()=>{
 it('lists only the own employment, prepares a sealed review with the engine minutes and no effect',async()=>{
  expect(await readOvertimeRequestChoices(ctx)).toMatchObject({kind:'choices',employments:[{employmentId:subject.employmentId}]});
  const before=await state();expect(before.requests).toEqual([]);
  const r=await prepare();expect(await state()).toEqual(before);
  expect(r.review).toEqual({employmentId:subject.employmentId,date:calendarDate(7),plannedStartTime:'18:00',plannedEndTime:'20:00',requestedOtMinutes:120,reason:'Fictional release preparation',remark:'Fictional optional note'});
  expect(r.consequence).toBe('overtime_requested_not_approved');
  expect(await custody(r.actionId)).toMatchObject({action_kind:action,state:'awaiting_confirmation',person_id:subject.personId,employment_id:subject.employmentId,receipt_subject_kind:'employment',receipt_subject_id:subject.employmentId,receipt_event_id:null,bodies:1});
  const [cipher]=await owner.db.execute<{body:string}>(sql`select ciphertext as body from app.assistant_own_leave_review_content where action_id=${r.actionId}::uuid`);expect(cipher.body).not.toContain('Fictional release preparation');
  expect(await reviews.reopen(ctx,r.actionId)).toEqual({kind:'prepared',review:r});
 });
 it('requests exactly once across duplicate deliveries, completes with that event, and never repeats',async()=>{
  const r=await prepare(),[first,second]=await Promise.all([confirm(r),confirm(r)]);
  expect(first).toEqual(second);if(first.kind!=='completed')throw Error('Expected a completed request');
  const after=await state();expect(after.requests).toHaveLength(1);expect(after.requested).toHaveLength(1);
  expect(after.requests[0]).toMatchObject({status:'pending',requestedOtMinutes:120,plannedStartTime:'18:00:00',plannedEndTime:'20:00:00',cancelledAt:null});
  expect(after.requested[0]).toEqual({id:after.requested[0].id,actorId:ctx.userId,aggregateId:after.requests[0].id,subjectEmploymentId:subject.employmentId});
  expect(first.receipt.receipt).toEqual({kind:'requested',correctionId:after.requests[0].id,eventId:after.requested[0].id,employmentId:subject.employmentId,date:calendarDate(7),requestedOtMinutes:120,currentStatus:'pending',cancelled:false});
  expect(await custody(r.actionId)).toMatchObject({state:'completed',receipt_event_id:after.requested[0].id,intent_digest:null,reviewed_digest:null,bodies:0});
  // A later identical confirmation and a reopen read the canonical receipt; neither requests again.
  expect(await confirm(r)).toEqual(first);expect(await reviews.reopen(ctx,r.actionId)).toEqual(first);
  await expect(reviews.discard(ctx,{actionId:r.actionId})).rejects.toThrow();expect(await state()).toEqual(after);
 });
 it('refuses when the same date was requested elsewhere after the review, writing nothing',async()=>{
  const r=await prepare();await requestAttendanceCorrection(ctx,nativeInput());const before=await state();expect(before.requests).toHaveLength(1);
  await expect(confirm(r)).rejects.toThrow();await expect(reviews.reopen(ctx,r.actionId)).rejects.toThrow();
  expect(await state()).toEqual(before);expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',receipt_event_id:null,bodies:1});
 });
 it('refuses a wrong digest and keeps one pending review per own employment',async()=>{
  const r=await prepare();await expect(confirm({actionId:r.actionId,reviewedDigest:'0'.repeat(64)})).rejects.toThrow();
  await expect(prepare(ctx,human({date:calendarDate(8)}))).rejects.toThrow();
  expect((await reviews.list(ctx)).reviews.map(row=>row.actionId)).toEqual([r.actionId]);expect((await state()).requests).toEqual([]);
 });
});
describe('ADR-0151 own overtime request: own-only and isolation',()=>{
 it('never prepares for another employment, even for an HR administrator',async()=>{
  const other=await hire('Fictional Other Employee');
  await expect(prepare(ctx,human({employmentId:other.employmentId}))).rejects.toThrow();
  const hrPerson=await hire('Fictional HR Administrator'),hr=await login(hrPerson.personId,'hr_admin');
  await expect(prepare(hr,human())).rejects.toThrow();await expect(prepare(hr,human({employmentId:other.employmentId}))).rejects.toThrow();
  // The HR administrator's own employment is still preparable for themselves (non-vacuity of the refusal above).
  expect((await prepare(hr,human({employmentId:hrPerson.employmentId}))).review.employmentId).toBe(hrPerson.employmentId);
  expect((await state()).requests).toEqual([]);
 });
 it('refuses another login of the same person and a foreign tenant from reopening, confirming or listing',async()=>{
  const r=await prepare(),second=await login(subject.personId);
  await expect(confirm(r,second)).rejects.toThrow();await expect(reviews.reopen(second,r.actionId)).rejects.toThrow();
  await expect(reviews.discard(second,{actionId:r.actionId})).rejects.toThrow();expect((await reviews.list(second)).reviews).toEqual([]);
  const foreign=await seedBase();await setModule(foreign.tenantId,'assistant','active');await setModule(foreign.tenantId,'attendance','active');
  const stranger=await hire('Fictional Foreign Requester',foreign),who=await login(stranger.personId,'employee',foreign);
  await expect(confirm(r,who)).rejects.toThrow();await expect(reviews.reopen(who,r.actionId)).rejects.toThrow();expect((await reviews.list(who)).reviews).toEqual([]);
  await expect(prepare(who,human())).rejects.toThrow();await expect(prepare(ctx,human({employmentId:stranger.employmentId}))).rejects.toThrow();
  expect((await state()).requests).toEqual([]);expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
 });
 it('rechecks the Assistant grant on confirmation but still lets the person discard',async()=>{
  const r=await prepare();await revokeAssistant(group(),{appUserId:ctx.userId!});const before=await state();
  await expect(confirm(r)).rejects.toThrow();expect(await state()).toEqual(before);
  expect((await reviews.discard(ctx,{actionId:r.actionId})).receipt.state).toBe('discarded');
  expect(await custody(r.actionId)).toMatchObject({state:'discarded',intent_digest:null,reviewed_digest:null,bodies:0});expect(await state()).toEqual(before);
 });
});
describe('ADR-0151 own overtime request: completion proof and outcome linking',()=>{
 it('refuses a request event committed in an earlier transaction as completion proof',async()=>{
  const r=await prepare(),prior=await withTenant(ctx,tx=>requestAttendanceCorrectionTx(tx,ctx,nativeInput()));expect(prior.eventId).toBeTruthy();
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.assistant_generic_review_complete(${r.actionId}::uuid,${action},${r.reviewedDigest},${prior.eventId}::uuid)`))).rejects.toThrow();
  expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',receipt_event_id:null,bodies:1});
 });
 it('links the completed review to its native outcome only for the same login',async()=>{
  const r=await prepare(),done=await confirm(r);if(done.kind!=='completed')throw Error('Expected a completed request');
  const reference={source:'review' as const,action,actionId:r.actionId};
  const [linked]=await withTenant(ctx,tx=>tx.execute<{completed:boolean}>(sql`select app.native_outcome_review_completed(${action},${r.actionId}::uuid) as completed`));expect(linked.completed).toBe(true);
  const outcome=await withTenant(ctx,tx=>readCompletedNativeOutcomeTx(tx,ctx,reference));
  expect(outcome.evidence).toEqual({action,sourceId:r.actionId,eventId:done.receipt.receipt.eventId,currentStatus:'pending'});expect(Number.isFinite(Date.parse(outcome.sourceExpiresAt))).toBe(true);
  const second=await login(subject.personId);await expect(withTenant(second,tx=>readCompletedNativeOutcomeTx(tx,second,reference))).rejects.toThrow();
  // A pending (not completed) review is never outcome evidence.
  const pending=await prepare(ctx,human({date:calendarDate(9)}));await expect(withTenant(ctx,tx=>readCompletedNativeOutcomeTx(tx,ctx,{...reference,actionId:pending.actionId}))).rejects.toThrow();
 });
});
