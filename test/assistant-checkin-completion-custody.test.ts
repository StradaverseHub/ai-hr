import {pgSqlState} from '../lib/db-error';
/** Fictional native check-ins, actual migrated shared custody and real principal/grant checks. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {scheduleCheckIn,completeCheckInTx} from '../packs/performance/service';
import * as perf from '../packs/performance/service';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {checkInCompletionReviews,readCheckInCompletionChoices} from '../core/assistant-actions/checkin-completion-review-store';
import {CheckInCompletion as C} from '../lib/assistant-actions/checkin-completion-contract';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
const hire=(name:string)=>hireEmployee(group(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
async function login(personId:string|null,role:'employee'|'manager'|'hr_admin'|'super_admin'):Promise<SessionContext>{const userId=await createAppUser(b.tenantId,personId,role);await grantAssistant(group(),{appUserId:userId});return{...await entitledCtx(b,[role]),userId,personId,grants:[{role,companyId:null}]};}
async function fixture(){
 const manager=await hire('Fictional Check-in Manager'),employee=await hire('Fictional Check-in Employee'),ctx=await login(manager.personId,'manager'),self=await login(employee.personId,'employee');
 await setReportingLine(group(),{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 const {id:checkinId}=await scheduleCheckIn(ctx,{subjectEmploymentId:employee.employmentId,scheduledOn:'2026-12-15',notes:'Private shared notes'});
 return{ctx,self,employee,checkinId,input:C.Human.parse({action:C.action,contractVersion:1,employmentId:employee.employmentId,subjectId:checkinId,complete:true,notesMode:'preserve'})};
}
const prepare=async(a:Awaited<ReturnType<typeof fixture>>)=>(await checkInCompletionReviews.prepare(a.ctx,a.input)).review;
const confirmation=(r:{actionId:string;reviewedDigest:string})=>({actionId:r.actionId,reviewedDigest:r.reviewedDigest});
async function state(checkinId:string){const [g]=await owner.db.select().from(schema.performanceCheckin).where(eq(schema.performanceCheckin.id,checkinId));const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,checkinId)).orderBy(schema.domainEvent.id);return{g,events};}
async function custody(id:string){const [row]=await owner.db.execute<{state:string;bodies:number}>(sql`select r.state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-checkin-custody-key-123456');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'performance','active');});
it('prepares no effect, confirms one exact native completion, retires private content and recovers without replay',async()=>{
 const a=await fixture(),before=await state(a.checkinId),choices=await readCheckInCompletionChoices(a.ctx,{query:''});expect(choices).toMatchObject({kind:'choices',items:[{subjectId:a.checkinId,employmentId:a.employee.employmentId,scheduledOn:'2026-12-15'}]});expect(JSON.stringify(choices)).not.toContain('Private shared notes');
 const r=await prepare(a);expect(await state(a.checkinId)).toEqual(before);expect(r.review).toMatchObject({before:'scheduled',after:'completed',scheduledOn:'2026-12-15',beforeNotes:'Private shared notes',afterNotes:'Private shared notes',notesMode:'preserve'});
 const completed=await checkInCompletionReviews.confirm(a.ctx,confirmation(r));expect(completed.kind).toBe('completed');const after=await state(a.checkinId);expect(after.g.status).toBe('completed');expect(after.g.notes).toBe('Private shared notes');expect(after.events.filter(e=>e.eventType==='performance-checkin.completed')).toHaveLength(1);expect(await custody(r.actionId)).toEqual({state:'completed',bodies:0});
 expect(await checkInCompletionReviews.confirm(a.ctx,confirmation(r))).toEqual(completed);expect(await checkInCompletionReviews.reopen(a.ctx,r.actionId)).toEqual(completed);expect(await state(a.checkinId)).toEqual(after);expect(JSON.stringify(completed)).not.toContain('Private shared notes');const outcome=await withTenant(a.ctx,tx=>checkInCompletionReviews.readCompletedOutcomeTx(tx,a.ctx,r.actionId));expect(outcome.eventId).toBe(after.events.find(event=>event.eventType==='performance-checkin.completed')!.id);
});
it('refuses changed native check-in date and incorrect human confirmation without a completion',async()=>{const a=await fixture(),r=await prepare(a);await expect(checkInCompletionReviews.confirm(a.ctx,{...confirmation(r),reviewedDigest:'0'.repeat(64)})).rejects.toThrow();await owner.db.update(schema.performanceCheckin).set({scheduledOn:'2026-12-16'}).where(eq(schema.performanceCheckin.id,a.checkinId));const before=await state(a.checkinId);await expect(checkInCompletionReviews.confirm(a.ctx,confirmation(r))).rejects.toThrow();expect(await state(a.checkinId)).toEqual(before);});
it('preserves the native super-admin self exception and denies the same-person ordinary employee',async()=>{
 const a=await fixture(),selfAdmin=await login(a.employee.personId,'super_admin');
 await expect(withTenant(a.self,tx=>completeCheckInTx(tx,a.self,{checkinId:a.checkinId}))).rejects.toThrow();await expect(checkInCompletionReviews.prepare(a.self,a.input)).rejects.toThrow();
 // Independent native positive contrast in a rollback; this is not an invented Assistant exception.
 const sentinel=new Error('native rollback');await expect(withTenant(selfAdmin,async tx=>{await completeCheckInTx(tx,selfAdmin,{checkinId:a.checkinId});throw sentinel;})).rejects.toThrow('native rollback');
 const r=(await checkInCompletionReviews.prepare(selfAdmin,a.input)).review;expect((await checkInCompletionReviews.confirm(selfAdmin,confirmation(r))).kind).toBe('completed');
 expect((await state(a.checkinId)).g).toMatchObject({status:'completed',notes:'Private shared notes'});
});
it('supports a real unlinked USER administrator while SYSTEM and a peer refuse a still-scheduled item',async()=>{
 const a=await fixture(),admin=await login(null,'hr_admin'),peer=await login((await hire('Fictional Check-in Peer')).personId,'employee'),before=await state(a.checkinId);
 expect(await readCheckInCompletionChoices(peer,{query:'',subjectId:a.checkinId})).toMatchObject({kind:'choices',items:[]});
 await expect(checkInCompletionReviews.prepare({...admin,userId:undefined},a.input)).rejects.toThrow();await expect(checkInCompletionReviews.prepare(peer,a.input)).rejects.toThrow();expect(await state(a.checkinId)).toEqual(before);
 const r=(await checkInCompletionReviews.prepare(admin,a.input)).review;expect((await checkInCompletionReviews.confirm(admin,confirmation(r))).kind).toBe('completed');
});
it('refuses foreign actor recovery and revoked Assistant authority',async()=>{const a=await fixture(),r=await prepare(a),other=await login(null,'hr_admin');await expect(checkInCompletionReviews.reopen(other,r.actionId)).rejects.toThrow();await revokeAssistant(group(),{appUserId:a.ctx.userId!});const before=await state(a.checkinId);await expect(checkInCompletionReviews.confirm(a.ctx,confirmation(r))).rejects.toThrow();expect(await state(a.checkinId)).toEqual(before);});
it('refuses wrong employment bindings and retirement performs no native approval',async()=>{const a=await fixture();await expect(checkInCompletionReviews.prepare(a.ctx,{...a.input,employmentId:randomUUID()})).rejects.toThrow();const r=await prepare(a),before=await state(a.checkinId);expect((await checkInCompletionReviews.discard(a.ctx,{actionId:r.actionId})).kind).toBe('retired');expect(await state(a.checkinId)).toEqual(before);expect(await custody(r.actionId)).toEqual({state:'discarded',bodies:0});});
it('rolls native completion row and event back if shared completion fails',async()=>{const a=await fixture(),r=await prepare(a),before=await state(a.checkinId);await owner.db.execute(sql`create function app.fictional_checkin_completion_fail() returns trigger language plpgsql as $$begin if NEW.action_kind='performance.checkin.complete' and NEW.state='completed' then raise exception 'Fictional completion failure';end if;return NEW;end$$`);await owner.db.execute(sql`create trigger fictional_checkin_completion_fail before update on app.assistant_own_leave_review for each row execute function app.fictional_checkin_completion_fail()`);try{await expect(checkInCompletionReviews.confirm(a.ctx,confirmation(r))).rejects.toThrow();expect(await state(a.checkinId)).toEqual(before);expect(await custody(r.actionId)).toEqual({state:'awaiting_confirmation',bodies:1});}finally{await owner.db.execute(sql`drop trigger fictional_checkin_completion_fail on app.assistant_own_leave_review`);await owner.db.execute(sql`drop function app.fictional_checkin_completion_fail()`);}});
it('refuses a removed administrative manager at confirmation without an effect',async()=>{const a=await fixture(),r=await prepare(a),replacement=await hire('Fictional Replacement Check-in Manager');await setReportingLine(group(),{subordinateEmploymentId:a.employee.employmentId,managerEmploymentId:replacement.employmentId,lineType:'administrative',validFrom:'2026-01-01'});const before=await state(a.checkinId);await expect(checkInCompletionReviews.confirm(a.ctx,confirmation(r))).rejects.toThrow();expect(await state(a.checkinId)).toEqual(before);});
it('keeps another actual tenant outside the subject and saved review',async()=>{const a=await fixture(),r=await prepare(a),other=await seedBase();await setModule(other.tenantId,'assistant','active');await setModule(other.tenantId,'performance','active');const userId=await createAppUser(other.tenantId,null,'hr_admin'),admin={...adminCtx(other),grants:[{role:'hr_admin' as const,companyId:null}]};await grantAssistant(admin,{appUserId:userId});const foreign={...await entitledCtx(other,['hr_admin']),userId,personId:null,grants:[{role:'hr_admin' as const,companyId:null}]};const before=await state(a.checkinId);expect(await readCheckInCompletionChoices(foreign,{query:'',subjectId:a.checkinId})).toMatchObject({kind:'choices',items:[]});await expect(checkInCompletionReviews.prepare(foreign,a.input)).rejects.toThrow();await expect(checkInCompletionReviews.reopen(foreign,r.actionId)).rejects.toThrow();expect(await state(a.checkinId)).toEqual(before);});

it('rejects every dedicated-family hybrid with the exact per-kind CHECK',async()=>{
 const a=await fixture(),r=await prepare(a),allowed=['action_kind','id','tenant_id','user_id','person_id','employment_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','decision_subject_person_id','receipt_subject_kind','receipt_subject_id','receipt_event_id','performance_postimage_version','performance_postimage_unchanged','performance_postimage_notes','performance_postimage_mode','performance_postimage_event_id','performance_postimage_root_xid'];
 const columns=await owner.db.execute<{name:string;type:string}>(sql`select attname as name,format_type(atttypid,atttypmod) as type from pg_attribute where attrelid='app.assistant_own_leave_review'::regclass and attnum>0 and not attisdropped order by attnum`);
 const dedicated=Array.from(columns).filter(column=>!allowed.includes(column.name));expect(dedicated.length).toBeGreaterThan(40);const sizes=await owner.db.execute<{name:string;bytes:number}>(sql`select conname as name,octet_length(pg_get_expr(conbin,conrelid)) as bytes from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and contype='c' order by conname`);console.info('[performance-checkin-constraint-evidence]',JSON.stringify({sizes,hybridColumns:dedicated.map(column=>column.name)}));
 for(const column of dedicated){const value=column.type==='uuid'?sql`${randomUUID()}::uuid`:column.type==='uuid[]'?sql`ARRAY[${randomUUID()}::uuid]`:column.type==='integer'?sql`1`:column.type==='text'?sql`'fictional-hybrid'`:column.type==='date'?sql`'2026-01-01'::date`:null;if(!value)throw Error(`Unreviewed dedicated column type ${column.name}: ${column.type}`);let failure:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(column.name)}=${value} where id=${r.actionId}::uuid`);}catch(error){failure=error;}expect(pgSqlState(failure),column.name).toBe('23514');}
 expect(await custody(r.actionId)).toEqual({state:'awaiting_confirmation',bodies:1});
});

it('refuses oversized notes before native projection and note-only drift before confirmation',async()=>{
 const a=await fixture(),projection=vi.spyOn(perf,'readCheckInCompletionPlanTx');await owner.db.update(schema.performanceCheckin).set({notes:'x'.repeat(8001)}).where(eq(schema.performanceCheckin.id,a.checkinId));
 await expect(prepare(a)).rejects.toThrow();expect(projection).not.toHaveBeenCalled();expect((await state(a.checkinId)).g.status).toBe('scheduled');
 await owner.db.update(schema.performanceCheckin).set({notes:'Human current notes'}).where(eq(schema.performanceCheckin.id,a.checkinId));const r=await prepare(a);
 await owner.db.update(schema.performanceCheckin).set({notes:'Changed notes'}).where(eq(schema.performanceCheckin.id,a.checkinId));const before=await state(a.checkinId);await expect(checkInCompletionReviews.confirm(a.ctx,confirmation(r))).rejects.toThrow();expect(await state(a.checkinId)).toEqual(before);
});
it('uses the native normalization of handwritten replacement notes and captures the actual native clock once',async()=>{
 const a=await fixture(),r=(await checkInCompletionReviews.prepare(a.ctx,{...a.input,notesMode:'replace',notes:'  Handwritten note\nline two  '})).review;
 expect(r.review).toMatchObject({beforeNotes:'Private shared notes',afterNotes:'Handwritten note\nline two',notesMode:'replace'});
 const before=Date.now(),result=await checkInCompletionReviews.confirm(a.ctx,confirmation(r)),after=await state(a.checkinId),event=after.events.find(e=>e.eventType==='performance-checkin.completed')!;
 expect(after.g.notes).toBe('Handwritten note\nline two');expect(after.g.completedAt!.getTime()).toBeGreaterThanOrEqual(before);expect(after.g.completedAt!.getTime()).toBeLessThanOrEqual(Date.now());
 expect(result).toMatchObject({kind:'completed',receipt:{receipt:{completedAt:after.g.completedAt!.toISOString(),eventId:event.id}}});
 expect(event.payload).toEqual({version:1,completedAt:after.g.completedAt!.toISOString()});expect(JSON.stringify(result)).not.toContain('Handwritten');
});
it('preserves the ordinary native UI and SYSTEM completion audit shape',async()=>{
 const a=await fixture();await withTenant(a.ctx,tx=>completeCheckInTx(tx,a.ctx,{checkinId:a.checkinId,notes:'  Native written notes  '}));const first=await state(a.checkinId);expect(first.g.notes).toBe('Native written notes');expect(first.events.find(e=>e.eventType==='performance-checkin.completed')!.payload).toBeNull();
 const system={...group(),userId:undefined,personId:null};const {id}=await scheduleCheckIn(system,{subjectEmploymentId:a.employee.employmentId,scheduledOn:'2026-12-16',notes:'Preserved native notes'});await withTenant(system,tx=>completeCheckInTx(tx,system,{checkinId:id}));const second=await state(id);expect(second.g.notes).toBe('Preserved native notes');expect(second.events.find(e=>e.eventType==='performance-checkin.completed')).toMatchObject({actorType:'system',payload:null});
});

it('recovers the original protected completion history after later native row edits without replay',async()=>{
 const a=await fixture(),r=await prepare(a),completed=await checkInCompletionReviews.confirm(a.ctx,confirmation(r)),before=await state(a.checkinId);
 await owner.db.update(schema.performanceCheckin).set({completedAt:new Date(before.g.completedAt!.getTime()+1000),notes:'Later independent notes'}).where(eq(schema.performanceCheckin.id,a.checkinId));
 expect(await checkInCompletionReviews.reopen(a.ctx,r.actionId)).toEqual(completed);expect((await state(a.checkinId)).events.filter(e=>e.eventType==='performance-checkin.completed')).toHaveLength(1);
});

it('checks fresh principal, module, pause and authority before any private native notes projection',async()=>{
 const a=await fixture(),projection=vi.spyOn(perf,'readCheckInCompletionPlanTx');
 await revokeAssistant(group(),{appUserId:a.ctx.userId!});await expect(prepare(a)).rejects.toThrow();expect(projection).not.toHaveBeenCalled();expect(await readCheckInCompletionChoices(a.ctx,{query:''})).toEqual({kind:'unavailable'});
 await grantAssistant(group(),{appUserId:a.ctx.userId!});await setModule(b.tenantId,'performance','disabled');await expect(prepare(a)).rejects.toThrow();expect(projection).not.toHaveBeenCalled();
});

it('rejects a matching row and reviewed event from a prior transaction as current completion proof',async()=>{
 const a=await fixture(),r=await prepare(a),effect=await withTenant(a.ctx,async tx=>{const plan=await perf.readCheckInCompletionPlanTx(tx,a.ctx,{checkinId:a.checkinId},true);return completeCheckInTx(tx,a.ctx,{checkinId:a.checkinId},plan.reviewDigest,true);});
 await expect(withTenant(a.ctx,tx=>tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${C.action},${r.reviewedDigest},${effect.eventId}::uuid)`))).rejects.toThrow();
 expect(await custody(r.actionId)).toEqual({state:'awaiting_confirmation',bodies:1});expect((await state(a.checkinId)).events.filter(e=>e.eventType==='performance-checkin.completed')).toHaveLength(1);
});
