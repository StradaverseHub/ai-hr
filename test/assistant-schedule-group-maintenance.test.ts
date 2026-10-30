import {employeeCodeMaintenanceReviews} from '../core/assistant-actions/employee-code-maintenance-review-store';
import {pgSqlState} from '../lib/db-error';
/** Authored for hosted migrated native/custody verification only. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createCompany,createDepartment} from '../core/admin';
import {grantAssistant} from '../core/assistant-grant';
import {createAttendanceRule,setAttendanceRuleStatus} from '../core/attendance-rule';
import {setEmploymentScheduleGroup,setEmploymentScheduleGroupTx,assignDefaultShift,createShift} from '../core/roster';
import {scheduleGroupMaintenanceReviews as store,readScheduleGroupMaintenanceChoices} from '../core/assistant-actions/schedule-group-maintenance-review-store';
import {ScheduleGroupMaintenance as C} from '../lib/assistant-actions/schedule-group-maintenance-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,target:{employmentId:string;personId:string},hrPerson:{employmentId:string;personId:string},ctx:SessionContext,groupId:string;
const root=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
const hire=(name:string)=>hireEmployee(root(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
async function login(personId:string|null,role:'hr_admin'|'employee'|'super_admin'='hr_admin',companyId:string|null=null):Promise<SessionContext>{
 const userId=personId?await createAppUser(b.tenantId,personId,role):(await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID(),personId:null}).returning({id:s.appUser.id}))[0].id;
 if(!personId)await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role,companyId});else if(companyId)await owner.db.update(s.roleAssignment).set({companyId}).where(eq(s.roleAssignment.appUserId,userId));
 await grantAssistant(root(),{appUserId:userId});return{...await entitledCtx(b,[role]),userId,personId,grants:[{role,companyId}]};
}
const human=(employmentId=target.employmentId,before:string|null=null,after:string|null=groupId)=>C.Human.parse({action:C.action,contractVersion:1,employmentId,subjectId:employmentId,expectedGroupId:before,attendanceRuleId:after});
const command=(r:{actionId:string;reviewedDigest:string})=>({actionId:r.actionId,reviewedDigest:r.reviewedDigest});
async function business(){return{rows:await owner.db.select().from(s.employment).where(eq(s.employment.tenantId,b.tenantId)).orderBy(s.employment.id),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.sequence)};}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-schedule-group-custody-key');await resetDb();b=await seedBase();for(const module of ['assistant','attendance'])await setModule(b.tenantId,module,'active');target=await hire('Fictional schedule target');hrPerson=await hire('Fictional schedule HR');ctx=await login(hrPerson.personId);groupId=(await createAttendanceRule(root(),{name:'Fictional schedule group',status:'active',lateGracePeriodMinutes:0,lateAfterMinutes:0,lateDeductMinutes:0,includeGraceInLateness:false,earlyGracePeriodMinutes:0,earlyAfterMinutes:0,earlyDeductMinutes:0,includeGraceInEarlyOut:false,applyToEarlyOt:false,otRows:[]})).id;});
it('prepares without effects, confirms exact native row/event once under concurrent replay and reopens historical receipt',async()=>{
 const before=await business(),r=(await store.prepare(ctx,human())).review;expect(await business()).toEqual(before);expect(r.review).toMatchObject({before:null,after:{id:groupId,name:'Fictional schedule group'},onDate:todayInKualaLumpur()});
 const [done,replay]=await Promise.all([store.confirm(ctx,command(r)),store.confirm(ctx,command(r))]);expect(replay).toEqual(done);expect(done.kind).toBe('completed');if(done.kind!=='completed')throw Error('Missing receipt');
 const [proof]=await owner.db.execute<{after:string;id:string}>(sql`select e.attendance_rule_id as after,d.id from employment e join domain_event d on d.aggregate_id=e.id and d.tenant_id=e.tenant_id where e.id=${target.employmentId}::uuid and d.id=${done.receipt.receipt.eventId}::uuid and d.event_type='employment.schedule-group.changed' and d.actor_id=${ctx.userId}::uuid and d.payload=jsonb_build_object('before',NULL,'after',${groupId}::text)`);expect(proof).toEqual({after:groupId,id:done.receipt.receipt.eventId});
 expect((await business()).events.filter(e=>e.eventType==='employment.schedule-group.changed')).toHaveLength(1);await setEmploymentScheduleGroup(ctx,{employmentId:target.employmentId,attendanceRuleId:null});expect(await store.reopen(ctx,r.actionId)).toEqual(done);
});
it('retains NULL clear and inactive native group selection',async()=>{await setAttendanceRuleStatus(root(),{ruleId:groupId,status:'inactive'});expect((await readScheduleGroupMaintenanceChoices(ctx,{query:''})).kind).toBe('choices');const r=(await store.prepare(ctx,human())).review;await store.confirm(ctx,command(r));const clear=(await store.prepare(ctx,human(target.employmentId,groupId,null))).review;expect(clear.review.after).toBeNull();expect((await store.confirm(ctx,command(clear))).kind).toBe('completed');});
it('preserves native default result shape/no-op zero-event and refuses unchanged proposals before custody',async()=>{const before=await business();expect(await setEmploymentScheduleGroup(ctx,{employmentId:target.employmentId,attendanceRuleId:null})).toEqual({id:target.employmentId,attendanceRuleId:null,changed:false});await expect(store.prepare(ctx,{...human(),attendanceRuleId:null})).rejects.toThrow();expect(await business()).toEqual(before);expect((await store.list(ctx)).reviews).toEqual([]);});
it('native own HR change succeeds while Assistant same-PERSON remains refused',async()=>{const self=await login(target.personId);expect(await setEmploymentScheduleGroup(self,{employmentId:target.employmentId,attendanceRuleId:groupId})).toEqual({id:target.employmentId,attendanceRuleId:groupId,changed:true});await expect(store.prepare(self,human(target.employmentId,groupId,null))).rejects.toThrow();});
it('returns exact same-topTx event only in opt-in mode and rolls back both native effects on outer failure',async()=>{const before=await business();await expect(withTenant(ctx,async tx=>{const native=await setEmploymentScheduleGroupTx(tx,ctx,{employmentId:target.employmentId,attendanceRuleId:groupId},{returnEventId:true});expect(native.eventId).toEqual(expect.any(String));const [proof]=await tx.execute(sql`select app.assistant_attendance_schedule_group_current_event(${target.employmentId}::uuid,${native.eventId}::uuid,'null'::jsonb,${JSON.stringify(groupId)}::jsonb)`);expect(proof).toBeTruthy();throw Error('outer rollback');})).rejects.toThrow('outer rollback');expect(await business()).toEqual(before);});
it.each(['name','employment','rotation'] as const)('refuses stale %s evidence',async kind=>{const r=(await store.prepare(ctx,human())).review;if(kind==='name')await owner.db.update(s.attendanceRule).set({name:'Changed group'}).where(eq(s.attendanceRule.id,groupId));if(kind==='employment')await owner.db.update(s.employment).set({employeeCode:'CHANGED'}).where(eq(s.employment.id,target.employmentId));if(kind==='rotation')await owner.db.update(s.attendanceRule).set({description:'Changed policy'}).where(eq(s.attendanceRule.id,groupId));const before=await business();await expect(store.confirm(ctx,command(r))).rejects.toThrow();expect(await business()).toEqual(before);});
it('refuses incompatible native reverse-check and rolls back the complete custody transaction',async()=>{const shift=await createShift(root(),{name:'Fictional shift',code:'F'+randomUUID().slice(0,6),startTime:'09:00:00',endTime:'18:00:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7]});await assignDefaultShift(root(),{employmentId:target.employmentId,shiftId:shift.id});const r=(await store.prepare(ctx,human())).review,before=await business();await expect(store.confirm(ctx,command(r))).rejects.toThrow();expect(await business()).toEqual(before);});
it('allows a real unlinked USER but refuses SYSTEM, ordinary employee, foreign company and spoofed actor fields',async()=>{
 const unlinked=await login(null);const r=(await store.prepare(unlinked,human())).review;expect((await store.confirm(unlinked,command(r))).kind).toBe('completed');await setEmploymentScheduleGroup(ctx,{employmentId:target.employmentId,attendanceRuleId:null});
 const company=await createCompany(root(),{legalName:'Fictional other company'});await createDepartment(root(),{companyId:company.id,name:'Other department'});const restricted=await login(hrPerson.personId,'hr_admin',company.id);
 for(const who of [{...ctx,userId:undefined,personId:null},await login(hrPerson.personId,'employee'),restricted]){expect(await readScheduleGroupMaintenanceChoices(who,{query:'',employmentId:target.employmentId})).toEqual({kind:'unavailable'});await expect(store.prepare(who,human())).rejects.toThrow();}
 await expect(store.prepare(ctx,{...human(),actor:'system'})).rejects.toThrow();
});

it('refuses every legacy-column hybrid while preserving a valid new-kind review and an existing kind',async()=>{
 const r=(await store.prepare(ctx,human())).review;
 for(const field of ['leave_request_id','submission_event_id','notification_event_id','profile_request_id','profile_requested_event_id','claim_draft_id','claim_saved_event_id','performance_ack_event_id']){
  let error:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(field)}=${randomUUID()}::uuid where id=${r.actionId}::uuid`);}catch(cause){error=cause;}expect(pgSqlState(error),field).toBe('23514');
 }
 expect((await store.confirm(ctx,command(r))).kind).toBe('completed');
 const [employee]=await owner.db.select({code:s.employment.employeeCode}).from(s.employment).where(eq(s.employment.id,target.employmentId));expect(employee).toBeTruthy();
 const old=(await employeeCodeMaintenanceReviews.prepare(ctx,{action:'employees.code.maintain',contractVersion:1,employmentId:target.employmentId,subjectId:target.employmentId,expectedCode:employee.code,employeeCode:'ATT-LEGACY42'})).review;
 expect((await employeeCodeMaintenanceReviews.confirm(ctx,command(old))).kind).toBe('completed');
 const [size]=await owner.db.execute<{bytes:number}>(sql`select octet_length(pg_get_expr(conbin,conrelid))::int as bytes from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and conname='assistant_review_kind_columns'`);expect(size.bytes).toBeGreaterThan(400);console.log('Attendance generic custody constraint bytes',size.bytes);
});
