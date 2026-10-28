/** ADR-0151 wave 1: own pending leave cancellation and edit through the generic review store (migration 0670).
 * Real migrated database and the real native leave service; fictional fixtures only. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {requestLeave,cancelOwnLeaveTx} from '../packs/leave/service';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {leaveCancellationReviews,leaveEditReviews,readLeaveChangeChoices} from '../core/assistant-actions/leave-change-review-store';
import {OWN_LEAVE_CANCELLATION_ACTION as cancelAction,OWN_LEAVE_EDIT_ACTION as editAction} from '../lib/assistant-actions/own-leave-change-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base,ctx:SessionContext,subject:{employmentId:string;personId:string},requestId:string,weekdays:string[];
beforeAll(async()=>{await migrateTestDb();const [installed]=await owner.db.execute<{ok:boolean}>(sql`select to_regprocedure('app.assistant_generic_review_prepare(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text)') is not null as ok`);expect(installed.ok,'Migration 0670 must be installed.').toBe(true);});
afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-leave-change-custody-key-123456789');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 subject=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Leave Changer',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(base.tenantId,subject.personId,'employee');await grantAssistant(adminCtx(base),{appUserId:userId});
 ctx={...await entitledCtx(base,['employee']),userId,personId:subject.personId,grants:[{role:'employee',companyId:null}]};
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:subject.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 weekdays=[];const next=new Date(todayInKualaLumpur()+'T00:00:00Z');while(weekdays.length<4){next.setUTCDate(next.getUTCDate()+1);if(![0,6].includes(next.getUTCDay()))weekdays.push(next.toISOString().slice(0,10));}
 requestId=(await requestLeave(ctx,{employmentId:subject.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:weekdays[0],endDate:weekdays[0],durationType:'full_day',reason:'Fictional family visit'})).leaveRequestId;
});
const cancelHuman=()=>({action:cancelAction,contractVersion:1 as const,employmentId:subject.employmentId,leaveRequestId:requestId,cancel:true as const});
const editHuman=(extra:Record<string,unknown>={})=>({action:editAction,contractVersion:1 as const,employmentId:subject.employmentId,leaveRequestId:requestId,startDate:weekdays[1],endDate:weekdays[2],...extra});
async function request(){const [row]=await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id,requestId));return row;}
async function events(type:string){return owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,base.tenantId),eq(schema.domainEvent.eventType,type)));}
async function custody(id:string){const [row]=await owner.db.execute(sql`select r.action_kind,r.state,r.receipt_subject_id,r.receipt_event_id,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}

describe('ADR-0151 own pending leave cancellation',()=>{
 it('lists the request, prepares without effect, and cancels once across duplicate deliveries',async()=>{
  expect(await readLeaveChangeChoices(ctx)).toMatchObject({kind:'choices',requests:[{leaveRequestId:requestId,startDate:weekdays[0],endDate:weekdays[0],days:1,reason:'Fictional family visit'}]});
  const prepared=(await leaveCancellationReviews.prepare(ctx,cancelHuman())).review;expect((await request()).status).toBe('pending');
  const confirmation={actionId:prepared.actionId,reviewedDigest:prepared.reviewedDigest};
  const [first,second]=await Promise.all([leaveCancellationReviews.confirm(ctx,confirmation),leaveCancellationReviews.confirm(ctx,confirmation)]);
  expect(first).toEqual(second);expect(first.kind).toBe('completed');expect((await request()).status).toBe('cancelled');
  const cancelled=await events('leave-request.self-cancelled');expect(cancelled).toHaveLength(1);
  expect(await custody(prepared.actionId)).toMatchObject({action_kind:'leave.cancel',state:'completed',receipt_subject_id:requestId,receipt_event_id:cancelled[0].id,bodies:0});
 });
 it('refuses after the request was edited elsewhere since the review',async()=>{
  const prepared=(await leaveCancellationReviews.prepare(ctx,cancelHuman())).review;
  const edit=(await leaveEditReviews.prepare(ctx,editHuman())).review;await leaveEditReviews.confirm(ctx,{actionId:edit.actionId,reviewedDigest:edit.reviewedDigest});
  await expect(leaveCancellationReviews.confirm(ctx,{actionId:prepared.actionId,reviewedDigest:prepared.reviewedDigest})).rejects.toThrow();
  expect((await request()).status).toBe('pending');
 });
 it('refuses another person\'s request and a revoked Assistant grant, but still allows discard',async()=>{
  const other=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Other Requester',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  await expect(leaveCancellationReviews.prepare(ctx,{...cancelHuman(),employmentId:other.employmentId})).rejects.toThrow();
  const prepared=(await leaveCancellationReviews.prepare(ctx,cancelHuman())).review;await revokeAssistant(adminCtx(base),{appUserId:ctx.userId!});
  await expect(leaveCancellationReviews.confirm(ctx,{actionId:prepared.actionId,reviewedDigest:prepared.reviewedDigest})).rejects.toThrow();
  expect((await leaveCancellationReviews.discard(ctx,{actionId:prepared.actionId})).receipt.state).toBe('discarded');expect((await request()).status).toBe('pending');
 });
 it('refuses a cancellation committed in another transaction as completion proof',async()=>{
  const prepared=(await leaveCancellationReviews.prepare(ctx,cancelHuman())).review,prior=await withTenant(ctx,tx=>cancelOwnLeaveTx(tx,ctx,{leaveRequestId:requestId}));
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.assistant_generic_review_complete(${prepared.actionId}::uuid,${cancelAction},${prepared.reviewedDigest},${prior.eventId}::uuid)`))).rejects.toThrow();
  expect(await custody(prepared.actionId)).toMatchObject({state:'awaiting_confirmation',receipt_event_id:null});
 });
});
describe('ADR-0151 own pending leave edit',()=>{
 it('shows the engine day count before and after, and edits only on confirmation',async()=>{
  const prepared=(await leaveEditReviews.prepare(ctx,editHuman({employeeRemark:'Fictional cover arranged'}))).review;
  expect(prepared.review).toMatchObject({before:{startDate:weekdays[0],endDate:weekdays[0],days:1,reason:'Fictional family visit'},after:{startDate:weekdays[1],endDate:weekdays[2],days:2,reason:'Fictional family visit',employeeRemark:'Fictional cover arranged'}});
  expect(await request()).toMatchObject({startDate:weekdays[0],status:'pending'});
  const done=await leaveEditReviews.confirm(ctx,{actionId:prepared.actionId,reviewedDigest:prepared.reviewedDigest});
  expect(done.kind).toBe('completed');expect(await request()).toMatchObject({startDate:weekdays[1],endDate:weekdays[2],days:'2.00',status:'pending',reason:'Fictional family visit',employeeRemark:'Fictional cover arranged'});
  expect(await events('leave-request.edited')).toHaveLength(1);
  // Reopening the completed review never edits again.
  expect((await leaveEditReviews.reopen(ctx,prepared.actionId)).kind).toBe('completed');expect(await events('leave-request.edited')).toHaveLength(1);
 });
 it('refuses when the request changed between review and confirmation',async()=>{
  const first=(await leaveEditReviews.prepare(ctx,editHuman())).review,cancel=(await leaveCancellationReviews.prepare(ctx,cancelHuman())).review;
  await leaveCancellationReviews.confirm(ctx,{actionId:cancel.actionId,reviewedDigest:cancel.reviewedDigest});
  await expect(leaveEditReviews.confirm(ctx,{actionId:first.actionId,reviewedDigest:first.reviewedDigest})).rejects.toThrow();
  expect((await request()).status).toBe('cancelled');expect(await events('leave-request.edited')).toHaveLength(0);
 });
 it('lists both review kinds separately for the person',async()=>{
  await leaveEditReviews.prepare(ctx,editHuman());await leaveCancellationReviews.prepare(ctx,cancelHuman());
  expect((await leaveEditReviews.list(ctx)).reviews).toHaveLength(1);expect((await leaveCancellationReviews.list(ctx)).reviews).toHaveLength(1);
 });
});
