/** Actual migrated rows, native services and protected custody. Hosted-only regression fixtures. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {createCycle,openCycle,createGoal,proposeGoals,scheduleCheckIn,approveGoalTx,updateGoal,readGoalApprovalSourceTx,readCheckInCancellationSourceTx,cancelCheckInTx,readCheckInCompletionPlanTx,completeCheckInTx} from '../packs/performance/service';
import {appendEvent} from '../db/events';
import {captureNativeOutcomeTargetsTx} from '../core/module-native-outcome-targets';
import {grantAssistant} from '../core/assistant-grant';
import {erasePersonPii,erasePersonPiiTx} from '../core/pdpa';
import {goalApprovalReviews,readGoalApprovalChoices} from '../core/assistant-actions/goal-approval-review-store';
import {checkInCancellationReviews} from '../core/assistant-actions/checkin-cancellation-review-store';
import {checkInCompletionReviews} from '../core/assistant-actions/checkin-completion-review-store';
import {GoalApproval as G} from '../lib/assistant-actions/goal-approval-contract';
import {CheckInCancellation as X} from '../lib/assistant-actions/checkin-cancellation-contract';
import {CheckInCompletion as C} from '../lib/assistant-actions/checkin-completion-contract';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
type Kind='goal'|'cancel'|'preserve'|'replace';
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
const hire=(name:string)=>hireEmployee(group(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
async function login(personId:string,role:'employee'|'manager'):Promise<SessionContext>{const userId=await createAppUser(b.tenantId,personId,role);await grantAssistant(group(),{appUserId:userId});return{...await entitledCtx(b,[role]),userId,personId,grants:[{role,companyId:null}]};}
type Packet={actionId:string;reviewedDigest:string};
async function fixture(kind:Kind){
 const manager=await hire('Fictional Proof Manager'),employee=await hire('Fictional Proof Employee'),ctx=await login(manager.personId,'manager'),self=await login(employee.personId,'employee');
 await setReportingLine(group(),{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 let id:string;
 if(kind==='goal'){
  const {cycleId}=await createCycle(group(),{name:'Fictional proof cycle',periodStart:'2026-01-01',periodEnd:'2026-12-31'});await openCycle(group(),{cycleId});
  ({id}=await createGoal(self,{employmentId:employee.employmentId,cycleId,title:'Reviewed title',description:'Private description',target:'Reviewed target'}));
  const [review]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,employee.employmentId)));await proposeGoals(self,{reviewId:review.id});
 }else ({id}=await scheduleCheckIn(ctx,{subjectEmploymentId:employee.employmentId,scheduledOn:'2026-12-15',notes:'Private original notes'}));
 const human={contractVersion:1,subjectId:id,employmentId:employee.employmentId};
 const g=G.Human.parse({...human,action:G.action,approve:true}),x=X.Human.parse({...human,action:X.action,cancel:true}),c=C.Human.parse({...human,action:C.action,complete:true,notesMode:kind==='replace'?'replace':'preserve',...(kind==='replace'?{notes:'\u00a0\uFEFF Human Unicode note \u2003\n'}:{})});
 const prepare=()=>kind==='goal'?goalApprovalReviews.prepare(ctx,g):kind==='cancel'?checkInCancellationReviews.prepare(ctx,x):checkInCompletionReviews.prepare(ctx,c);
 const confirm=(r:Packet)=>kind==='goal'?goalApprovalReviews.confirm(ctx,r):kind==='cancel'?checkInCancellationReviews.confirm(ctx,r):checkInCompletionReviews.confirm(ctx,r);
 const reopen=(actionId:string)=>kind==='goal'?goalApprovalReviews.reopen(ctx,actionId):kind==='cancel'?checkInCancellationReviews.reopen(ctx,actionId):checkInCompletionReviews.reopen(ctx,actionId);
 return{kind,id,ctx,self,manager,employee,prepare,confirm,reopen,action:kind==='goal'?G.action:kind==='cancel'?X.action:C.action};
}
async function state(a:Awaited<ReturnType<typeof fixture>>){const row=a.kind==='goal'?(await owner.db.select().from(schema.performanceGoal).where(eq(schema.performanceGoal.id,a.id)))[0]:(await owner.db.select().from(schema.performanceCheckin).where(eq(schema.performanceCheckin.id,a.id)))[0];return{row,events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,a.id)).orderBy(schema.domainEvent.sequence)};}
async function proof(actionId:string){const [r]=await owner.db.execute<{version:number|null;unchanged:string|null;notes:string|null;mode:string|null;event:string|null;root:string|null;state:string;bodies:number}>(sql`select performance_postimage_version as version,performance_postimage_unchanged as unchanged,performance_postimage_notes as notes,performance_postimage_mode as mode,performance_postimage_event_id as event,performance_postimage_root_xid::text as root,state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where id=${actionId}::uuid`);return r;}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-postimage-proof-key-123456');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'performance','active');});

for(const kind of ['goal','cancel','preserve','replace'] as const)for(const stage of ['update','event','before-custody','custody','body'] as const){
 it(`rolls back ${kind} actual persisted-row tampering during ${stage}`,async()=>{
  const a=await fixture(kind),r=(await a.prepare()).review,before=await state(a);
  const table=stage==='body'?'app.assistant_own_leave_review_content':stage==='event'?'public.domain_event':stage.endsWith('custody')?'app.assistant_own_leave_review':kind==='goal'?'public.performance_goal':'public.performance_checkin';
  const condition=stage==='body'?`OLD.action_id='${r.actionId}'::uuid`:stage==='event'?`NEW.aggregate_id='${a.id}'::uuid AND NEW.event_type='${kind==='goal'?'performance-goal.approved':kind==='cancel'?'performance-checkin.cancelled':'performance-checkin.completed'}'`:stage.endsWith('custody')?`NEW.id='${r.actionId}'::uuid AND NEW.state='completed'`:kind==='goal'?`NEW.id='${a.id}'::uuid AND NEW.approval_status='approved'`:`NEW.id='${a.id}'::uuid AND NEW.status='${kind==='cancel'?'cancelled':'completed'}'`;
  const mutation=kind==='goal'?`UPDATE public.performance_goal SET title='Unreviewed trigger title' WHERE id='${a.id}'::uuid;`:kind==='cancel'?`UPDATE public.performance_checkin SET scheduled_on='2026-12-31',notes='Unreviewed cancellation notes' WHERE id='${a.id}'::uuid;`:`UPDATE public.performance_checkin SET notes='Unreviewed completion notes' WHERE id='${a.id}'::uuid;`;
  await owner.db.execute(sql.raw(`CREATE FUNCTION app.fictional_postimage_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN IF pg_trigger_depth()=1 AND (${condition}) THEN ${mutation} END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END$$`));
  await owner.db.execute(sql.raw(`CREATE TRIGGER fictional_postimage_tamper ${stage==='before-custody'?'BEFORE':'AFTER'} ${stage==='event'?'INSERT':stage==='body'?'DELETE':'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION app.fictional_postimage_tamper()`));
  try{await expect(a.confirm(r)).rejects.toThrow();expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({version:1,state:'awaiting_confirmation',bodies:1});}
  finally{await owner.db.execute(sql.raw(`DROP TRIGGER fictional_postimage_tamper ON ${table}`));await owner.db.execute(sql`DROP FUNCTION app.fictional_postimage_tamper()`);}
 });
}
for(const kind of ['goal','cancel','preserve','replace'] as const){
 it(`keeps ${kind} commitments private, clears them on completion, recovers original history`,async()=>{
  const a=await fixture(kind),r=(await a.prepare()).review,p=await proof(r.actionId);expect(p.version).toBe(1);expect(p.root).toBeNull();expect(p.unchanged).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(r)).not.toContain(p.unchanged!);
  const result=await a.confirm(r);expect(result.kind).toBe('completed');expect(await proof(r.actionId)).toMatchObject({version:1,state:'completed',unchanged:null,notes:null,mode:null,bodies:0});
  expect((await proof(r.actionId)).root).toMatch(/^[0-9]+$/);expect(JSON.stringify(result)).not.toContain('Private');expect(await a.reopen(r.actionId)).toEqual(result);
  if(kind==='replace'){const [row]=await owner.db.select().from(schema.performanceCheckin).where(eq(schema.performanceCheckin.id,a.id));expect(row.notes).toBe('Human Unicode note');}
  if(kind==='goal'){await updateGoal(a.self,{goalId:a.id,title:'Legitimate later human edit'});expect(await a.reopen(r.actionId)).toEqual(result);expect((await state(a)).events.filter(e=>e.eventType==='performance-goal.approved')).toHaveLength(1);}
 });
}
it('SQL derives preservation from the locked DB notes and uses pure UTC serialization without changing authority timezone',async()=>{
 const a=await fixture('preserve');
 const result=await withTenant(a.ctx,async tx=>{
  await tx.execute(sql`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
  const [first]=await tx.execute<{p:unknown;zone:string}>(sql`select app.assistant_performance_review_expected(${a.action},${a.id}::uuid,'preserve','FORGED preserved notes') as p,current_setting('TimeZone') as zone`);
  await tx.execute(sql`SET LOCAL TIME ZONE 'America/Adak'`);
  const [second]=await tx.execute<{p:unknown;zone:string}>(sql`select app.assistant_performance_review_expected(${a.action},${a.id}::uuid,'preserve',NULL) as p,current_setting('TimeZone') as zone`);return{first,second};
 });expect(result.first.p).toEqual(result.second.p);expect(result.first.zone).toBe('Pacific/Kiritimati');expect(result.second.zone).toBe('America/Adak');
});
it('rejects forged prepare commitments before inserting custody',async()=>{
 const a=await fixture('goal'),id=randomUUID();
 await expect(withTenant(a.ctx,tx=>tx.execute(sql`select app.assistant_performance_review_prepare(${a.action},${id}::uuid,${a.ctx.personId}::uuid,${a.employee.employmentId}::uuid,${b.companyId}::uuid,${a.employee.personId}::uuid,${a.id}::uuid,${'1'.repeat(64)},${'2'.repeat(64)},'fictional','fictional','fictional',${JSON.stringify({version:1,unchanged:'0'.repeat(64),notes:null,notesMode:null})}::jsonb,NULL)`))).rejects.toMatchObject({cause:{code:'42501',message:'Performance source changed before custody'}});expect(await proof(id)).toBeUndefined();
});
for(const completed of [false,true])it(`refuses retroactive proof for a genuine legacy ${completed?'completed':'pending'} packet`,async()=>{
 const a=await fixture('goal'),r=(await a.prepare()).review,legacyId=randomUUID();
 const [saved]=await owner.db.execute<{packet:Record<string,unknown>;body:Record<string,unknown>}>(sql`select to_jsonb(r) as packet,to_jsonb(c) as body from app.assistant_own_leave_review r join app.assistant_own_leave_review_content c on c.action_id=r.id where r.id=${r.actionId}::uuid`);
 // Release the per-subject pending uniqueness through the actual lifecycle, preserving the old row.
 await goalApprovalReviews.discard(a.ctx,{actionId:r.actionId});
 // A genuine ordinary native completion owns a new unique event; no qualified receipt is cloned,
 // and no protected historical marker, event or uniqueness constraint is rewritten.
 const eventId=completed?(await withTenant(a.ctx,tx=>approveGoalTx(tx,a.ctx,{goalId:a.id}))).eventId:null;
 const packet={...saved.packet,id:legacyId,state:completed?'completed':'awaiting_confirmation',...(completed?{intent_digest:null,reviewed_digest:null,receipt_event_id:eventId}:{}),performance_postimage_version:null,performance_postimage_unchanged:null,performance_postimage_notes:null,performance_postimage_mode:null,performance_postimage_event_id:null,performance_postimage_root_xid:null};
 await owner.db.execute(sql`insert into app.assistant_own_leave_review select (jsonb_populate_record(NULL::app.assistant_own_leave_review,${JSON.stringify(packet)}::jsonb)).*`);
 if(!completed)await owner.db.execute(sql`insert into app.assistant_own_leave_review_content select (jsonb_populate_record(NULL::app.assistant_own_leave_review_content,${JSON.stringify({...saved.body,action_id:legacyId})}::jsonb)).*`);
 const before=await state(a);if(completed)await expect(a.reopen(legacyId)).rejects.toThrow();else expect(await a.reopen(legacyId)).toMatchObject({kind:'retired'});
 expect(await proof(legacyId)).toMatchObject({version:null,unchanged:null,notes:null,mode:null,state:completed?'completed':'refused',bodies:0});expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'discarded',bodies:0});
});
for(const completed of [false,true])it(`canonical erasure clears sensitive proof for ${completed?'body-gone completed':'pending'} custody`,async()=>{
 const a=await fixture('preserve'),r=(await a.prepare()).review;if(completed)await a.confirm(r);
 await erasePersonPii(group(),{subjectEmploymentId:a.employee.employmentId,scope:'contact',reason:'Fictional human privacy request',requestRef:'fictional-proof-'+randomUUID()});
 expect(await proof(r.actionId)).toMatchObject({unchanged:null,notes:null,mode:null,bodies:0,state:completed?'completed':'refused'});
 const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'pii.erased'));expect(events.length).toBeGreaterThan(0);
});
it('documents the genuine functional-partner native-positive and bounded Assistant-negative goal door',async()=>{
 const a=await fixture('goal'),partner=await hire('Fictional Functional Partner');
 const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID(),personId:partner.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,companyId:b.companyId,role:'performance_comp_partner'});await grantAssistant(group(),{appUserId:u.id});
 const ctx:SessionContext={...await entitledCtx(b,['performance_comp_partner']),userId:u.id,personId:partner.personId,grants:[{role:'performance_comp_partner',companyId:b.companyId}]};
 // Both are genuine managers at the native delegation write-time level. The partner manages a
 // DIFFERENT employee; this creates no administrative visibility of the original goal's subject.
 const separateReport=await hire('Fictional Partner Separate Direct Report');
 await setReportingLine(group(),{subordinateEmploymentId:separateReport.employmentId,managerEmploymentId:partner.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 await setReportingLine(group(),{subordinateEmploymentId:a.manager.employmentId,managerEmploymentId:partner.employmentId,lineType:'delegate',validFrom:'2026-01-01',reason:'Fictional whole-scope stand-in'});
 const scopes=await withTenant(ctx,tx=>tx.execute<{general:boolean;functional:boolean}>(sql`select app.can_see_employment(${a.employee.employmentId}::uuid) as general,app.can_admin_perfcomp_employment(${a.employee.employmentId}::uuid) as functional`));expect(scopes[0]).toEqual({general:false,functional:true});
 await expect(withTenant(ctx,async tx=>{await approveGoalTx(tx,ctx,{goalId:a.id});throw Error('native positive rollback');})).rejects.toThrow('native positive rollback');
 expect(await readGoalApprovalChoices(ctx,{query:'',subjectId:a.id})).toMatchObject({kind:'choices',items:[]});await expect(goalApprovalReviews.prepare(ctx,{action:G.action,contractVersion:1,employmentId:a.employee.employmentId,subjectId:a.id,approve:true})).rejects.toThrow();
 expect((await state(a)).row).toMatchObject({approvalStatus:'proposed'});
});


async function completeProtectedTx(tx:Tx,a:Awaited<ReturnType<typeof fixture>>,r:Packet){
  let eventId:string;
  if(a.kind==='goal'){const current=await readGoalApprovalSourceTx(tx,a.ctx,a.id,true);eventId=(await approveGoalTx(tx,a.ctx,{goalId:a.id},current.reviewDigest,true)).eventId;}
  else if(a.kind==='cancel'){const current=await readCheckInCancellationSourceTx(tx,a.ctx,a.id,true);eventId=(await cancelCheckInTx(tx,a.ctx,{checkinId:a.id},current.reviewDigest,true)).eventId;}
  else{const input={checkinId:a.id,...(a.kind==='replace'?{notes:'\u00a0\uFEFF Human Unicode note \u2003\n'}:{})},current=await readCheckInCompletionPlanTx(tx,a.ctx,input,true);eventId=(await completeCheckInTx(tx,a.ctx,input,current.reviewDigest,true)).eventId;}
  await captureNativeOutcomeTargetsTx(tx,a.ctx,{action:a.action,sourceId:r.actionId,eventId,targets:[{kind:'employment',id:a.employee.employmentId},{kind:'person',id:a.employee.personId}]});
  await tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${a.action},${r.reviewedDigest},${eventId}::uuid)`);
}

// The callable SQL boundary must close over the rest of the actual transaction, even after an
// immediate constraint flush. Each attempted mutation has an independent authorized positive contrast.
for(const kind of ['goal','cancel','preserve','replace'] as const)for(const mutation of ['row','event','actor'] as const)it(`fences ${kind} ${mutation} writes after protected completion and immediate constraints`,async()=>{
 const a=await fixture(kind);
 if(mutation==='actor'){await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:a.ctx.userId!,companyId:null,role:'hr_admin'});a.ctx.grants=[{role:'manager',companyId:null},{role:'hr_admin',companyId:null}];a.ctx.roles=['manager','hr_admin'];}
 const r=(await a.prepare()).review,before=await state(a),replacement=await hire('Fictional Later Actor Binding');
 async function mutate(tx:Tx){
  if(mutation==='row'){
   const rows=kind==='goal'?await tx.update(schema.performanceGoal).set({title:'Later same-transaction title'}).where(eq(schema.performanceGoal.id,a.id)).returning({id:schema.performanceGoal.id}):await tx.update(schema.performanceCheckin).set({scheduledOn:'2026-12-31'}).where(eq(schema.performanceCheckin.id,a.id)).returning({id:schema.performanceCheckin.id});expect(rows).toHaveLength(1);
  }else if(mutation==='actor'){
   const rows=await tx.update(schema.appUser).set({personId:replacement.personId}).where(eq(schema.appUser.id,a.ctx.userId!)).returning({id:schema.appUser.id});expect(rows).toHaveLength(1);
  }else await appendEvent(tx,{tenantId:b.tenantId,aggregateType:kind==='goal'?'performance-goal':'performance-checkin',aggregateId:a.id,eventType:'fictional.performance-extra',actor:{type:'user',id:a.ctx.userId!},subjectEmploymentId:a.employee.employmentId});
 }
 // Real app-role UPDATE RETURNING/append owner; a zero-row RLS fixture cannot prove this fence.
 await expect(withTenant(a.ctx,async tx=>{await mutate(tx);throw Error('positive mutation rollback');})).rejects.toThrow('positive mutation rollback');
 await expect(withTenant(a.ctx,async tx=>{
  await completeProtectedTx(tx,a,r);
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await mutate(tx);
 })).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed command is closed until commit'}});
 expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
});

it('refuses a real child-savepoint native effect as a top-transaction completion witness',async()=>{
 const a=await fixture('goal'),r=(await a.prepare()).review,before=await state(a);
 await expect(withTenant(a.ctx,async tx=>{await tx.execute(sql`SAVEPOINT fictional_child_effect`);const current=await readGoalApprovalSourceTx(tx,a.ctx,a.id,true),effect=await approveGoalTx(tx,a.ctx,{goalId:a.id},current.reviewDigest,true);await tx.execute(sql`RELEASE SAVEPOINT fictional_child_effect`);await tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${a.action},${r.reviewedDigest},${effect.eventId}::uuid)`);})).rejects.toMatchObject({cause:{code:'42501',message:'Performance postimage unavailable'}});expect(await state(a)).toEqual(before);
});
it('refuses a matching native goal/event committed by an earlier transaction',async()=>{
 const a=await fixture('goal'),r=(await a.prepare()).review,effect=await withTenant(a.ctx,async tx=>{const current=await readGoalApprovalSourceTx(tx,a.ctx,a.id,true);return approveGoalTx(tx,a.ctx,{goalId:a.id},current.reviewDigest,true);}),before=await state(a);
 await expect(withTenant(a.ctx,tx=>tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${a.action},${r.reviewedDigest},${effect.eventId}::uuid)`))).rejects.toMatchObject({cause:{code:'42501',message:'Performance postimage unavailable'}});expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
});
it('keeps nondeferrable fences active within a later child savepoint',async()=>{
 const a=await fixture('cancel'),r=(await a.prepare()).review,before=await state(a);
 await expect(withTenant(a.ctx,async tx=>{await completeProtectedTx(tx,a,r);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);await tx.execute(sql`SAVEPOINT fictional_child_tamper`);await tx.update(schema.performanceCheckin).set({notes:'Child tamper'}).where(eq(schema.performanceCheckin.id,a.id));await tx.execute(sql`RELEASE SAVEPOINT fictional_child_tamper`);})).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed command is closed until commit'}});expect(await state(a)).toEqual(before);
});
it('does not let a context switch hide the same transaction receipt from a real group administrator writer',async()=>{
 const a=await fixture('goal'),r=(await a.prepare()).review,before=await state(a);
 await expect(withTenant(a.ctx,async tx=>{await completeProtectedTx(tx,a,r);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);await tx.execute(sql`select set_config('app.user_id',${b.adminUserId},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:null}])},true)`);await tx.update(schema.performanceGoal).set({title:'Context-switch tamper'}).where(eq(schema.performanceGoal.id,a.id));})).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed command is closed until commit'}});expect(await state(a)).toEqual(before);
});
for(const field of ['delete','state','action_kind','receipt_subject_id','user_id','performance_postimage_root_xid'] as const)it(`keeps completed ${field} immutable even when an owner trigger tries removing the fence anchor`,async()=>{
 const a=await fixture('goal'),r=(await a.prepare()).review,before=await state(a),value=field==='state'?"'refused'":field==='action_kind'?"'performance.checkin.cancel'":field==='performance_postimage_root_xid'?'NULL':`'${randomUUID()}'::uuid`;
 await owner.db.execute(sql.raw(`CREATE FUNCTION app.fictional_remove_proof_anchor() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN IF NEW.id='${r.actionId}'::uuid AND NEW.state='completed' AND pg_trigger_depth()=1 THEN ${field==='delete'?'DELETE FROM app.assistant_own_leave_review WHERE id=NEW.id;':`UPDATE app.assistant_own_leave_review SET ${field}=${value} WHERE id=NEW.id;`}END IF;RETURN NEW;END$$`));
 await owner.db.execute(sql`CREATE TRIGGER fictional_remove_proof_anchor AFTER UPDATE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app.fictional_remove_proof_anchor()`);
 try{await expect(a.confirm(r)).rejects.toThrow();expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});}
 finally{await owner.db.execute(sql`DROP TRIGGER fictional_remove_proof_anchor ON app.assistant_own_leave_review`);await owner.db.execute(sql`DROP FUNCTION app.fictional_remove_proof_anchor()`);}
});
it('refuses canonical erasure of the original subject after completion in the same transaction',async()=>{
 const a=await fixture('preserve');await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:a.ctx.userId!,companyId:null,role:'hr_admin'});a.ctx.grants=[{role:'manager',companyId:null},{role:'hr_admin',companyId:null}];a.ctx.roles=['manager','hr_admin'];const r=(await a.prepare()).review,before=await state(a);
 await expect(withTenant(a.ctx,async tx=>{await completeProtectedTx(tx,a,r);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);await erasePersonPiiTx(tx,a.ctx,{subjectEmploymentId:a.employee.employmentId,scope:'contact',reason:'Fictional same-transaction erasure',requestRef:'fictional-'+randomUUID()});})).rejects.toThrow();expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
});

for(const retarget of ['old-event','new-event','subject-employment'] as const)it(`guards ${retarget} retargeting against protected receipt identities`,async()=>{
 const a=await fixture('goal'),other=await hire('Fictional Other Employment'),r=(await a.prepare()).review,before=await state(a),otherAggregate=randomUUID();
 // These adversarial owner-trigger mutations test OLD/NEW matching; ordinary app event UPDATE is
 // already denied by the immutable domain-event grants and is not claimed as an app-role contrast.
 const mutation=retarget==='subject-employment'?`UPDATE public.employment SET person_id='${other.personId}'::uuid WHERE id='${a.employee.employmentId}'::uuid;`:retarget==='old-event'?`UPDATE public.domain_event SET aggregate_id='${otherAggregate}'::uuid WHERE id=NEW.receipt_event_id;`:`INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id) VALUES('${b.tenantId}'::uuid,'performance-goal','${otherAggregate}'::uuid,'fictional.before-retarget','user','${a.ctx.userId}'::uuid,'${a.employee.employmentId}'::uuid);UPDATE public.domain_event SET aggregate_id='${a.id}'::uuid WHERE aggregate_id='${otherAggregate}'::uuid;`;
 await owner.db.execute(sql.raw(`CREATE FUNCTION app.fictional_retarget_completed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN IF NEW.id='${r.actionId}'::uuid AND NEW.state='completed' AND pg_trigger_depth()=1 THEN ${mutation} END IF;RETURN NEW;END$$`));await owner.db.execute(sql`CREATE TRIGGER fictional_retarget_completed AFTER UPDATE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app.fictional_retarget_completed()`);
 try{await expect(a.confirm(r)).rejects.toThrow();expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});}
 finally{await owner.db.execute(sql`DROP TRIGGER fictional_retarget_completed ON app.assistant_own_leave_review`);await owner.db.execute(sql`DROP FUNCTION app.fictional_retarget_completed()`);}
});

for(const kind of ['goal','cancel','preserve','replace'] as const)it(`preserves the existing default ${kind} native source/digest writer API`,async()=>{
 const a=await fixture(kind);
 await withTenant(a.ctx,async tx=>{
  if(kind==='goal'){const source=await readGoalApprovalSourceTx(tx,a.ctx,a.id);expect(source.postimageProof).toBeUndefined();await approveGoalTx(tx,a.ctx,{goalId:a.id},source.reviewDigest);}
  else if(kind==='cancel'){const source=await readCheckInCancellationSourceTx(tx,a.ctx,a.id);expect(source.postimageProof).toBeUndefined();await cancelCheckInTx(tx,a.ctx,{checkinId:a.id},source.reviewDigest);}
  else{const input={checkinId:a.id,...(kind==='replace'?{notes:' Default native replacement '}:{})},source=await readCheckInCompletionPlanTx(tx,a.ctx,input);expect(source.postimageProof).toBeUndefined();await completeCheckInTx(tx,a.ctx,input,source.reviewDigest);}
 });
 const after=await state(a);expect(after.row).toMatchObject(kind==='goal'?{approvalStatus:'approved'}:{status:kind==='cancel'?'cancelled':'completed'});expect(after.events.filter(e=>e.eventType===({goal:'performance-goal.approved',cancel:'performance-checkin.cancelled',preserve:'performance-checkin.completed',replace:'performance-checkin.completed'}[kind]))).toHaveLength(1);
});

for(const kind of ['goal','cancel','preserve','replace'] as const)for(const changed of ['root','actor-person'] as const)it(`refuses ${kind} initial persisted custody ${changed} rewrite by a later BEFORE trigger`,async()=>{
 const a=await fixture(kind),r=(await a.prepare()).review,before=await state(a);
 const mutation=changed==='root'?"NEW.performance_postimage_root_xid:='0'::xid8;":`NEW.person_id:='${a.employee.personId}'::uuid;`;
 // Alphabetical order is deliberate: this mutates NEW AFTER performance_postimage_retire, while
 // OLD is still awaiting_confirmation, before the completed writer fences can see a stored anchor.
 await owner.db.execute(sql.raw(`CREATE FUNCTION app.zz_fictional_completed_metadata() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN IF NEW.id='${r.actionId}'::uuid AND NEW.state='completed' AND pg_trigger_depth()=1 THEN ${mutation} END IF;RETURN NEW;END$$`));
 await owner.db.execute(sql`CREATE TRIGGER zz_fictional_completed_metadata BEFORE UPDATE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app.zz_fictional_completed_metadata()`);
 try{await expect(withTenant(a.ctx,tx=>completeProtectedTx(tx,a,r))).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed custody changed'}});expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',root:null,event:null,bodies:1});}
 finally{await owner.db.execute(sql`DROP TRIGGER zz_fictional_completed_metadata ON app.assistant_own_leave_review`);await owner.db.execute(sql`DROP FUNCTION app.zz_fictional_completed_metadata()`);}
});
