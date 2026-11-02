/** Actual original native courses and current/stored floor parity; no fabricated supported rows. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {createAttendanceRule,updateAttendanceRule,copyAttendanceRule,deleteAttendanceRule,setRuleShifts,type AttendanceRuleInput} from '../packs/attendance/service';
import {createShift,copyShift,updateShift,archiveShift,unarchiveShift,deleteShift,replaceShiftOtWindows,listShiftsForTenant,listShiftsForMaintenance,listShiftOtWindows,shiftActionAccess,type ShiftInput} from '../core/roster';
import {getScheduleRotation,saveScheduleRotation,rotationActionAccess} from '../packs/attendance/service';
import {readDataPermissions,previewDataPermission,saveDataPermission,type DataPermissionCommand,type DataPermissionState,type DataPermissionPreview} from '../core/data-permissions';
import {scheduleGroupControls,saveScheduleGroupControl,scheduleControlActionAccess} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext,companyHr:SessionContext;
const ruleInput=(name:string):AttendanceRuleInput=>({name,lateGracePeriodMinutes:0,lateAfterMinutes:0,lateDeductMinutes:0,includeGraceInLateness:false,earlyGracePeriodMinutes:0,earlyAfterMinutes:0,earlyDeductMinutes:0,includeGraceInEarlyOut:false,applyToEarlyOt:false,otRows:[]});
const shiftInput=(name:string):ShiftInput=>({name,code:randomUUID().slice(0,8),startTime:'08:00',endTime:'17:00',breakMinutes:60});
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();admin=adminCtx(b);const userId=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));companyHr={...admin,userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};});
it('retains genuine company-HR ordinary Schedule Group construction, copy and edit',async()=>{
 const [native]=await withTenant(companyHr,tx=>tx.execute<{anyHr:boolean;groupHr:boolean}>(sql`select app.is_admin() as "anyHr",app.is_group_admin() as "groupHr"`));expect(native).toEqual({anyHr:true,groupHr:false});
 const group=await createAttendanceRule(companyHr,ruleInput('Fictional company HR group'));
 await updateAttendanceRule(companyHr,{...ruleInput('Fictional company HR revised'),ruleId:group.id});
 const copied=await copyAttendanceRule(companyHr,{ruleId:group.id});expect(copied.id).not.toBe(group.id);
 await deleteAttendanceRule(companyHr,{ruleId:copied.id});expect(await owner.db.select().from(s.attendanceRule).where(eq(s.attendanceRule.id,copied.id))).toEqual([]);
 expect((await owner.db.select().from(s.attendanceRule).where(eq(s.attendanceRule.id,group.id)))[0].name).toBe('Fictional company HR revised');
});
it('aligns actual native stored/current Schedule floors without claiming installed publication',async()=>{
 const floors=await owner.withTenant(companyHr,tx=>tx.execute<{operation:string;stored:boolean;current:boolean;delegation:boolean}>(sql`select operation,app.module_function_legacy_allowed(${b.tenantId}::uuid,${companyHr.userId}::uuid,'function.attendancePolicy.schedule.'||operation,null) as stored,app.module_function_current_legacy_allowed(${b.tenantId}::uuid,${companyHr.userId}::uuid,'function.attendancePolicy.schedule.'||operation,null) as "current",app.access_function_delegation_floor('function.attendancePolicy.schedule.'||operation,null) as delegation from unnest(ARRAY['view','add','edit','delete']) operation`));
 expect(floors).toEqual(['view','add','edit','delete'].map(operation=>({operation,stored:true,current:true,delegation:true})));
 await expect(withTenant(companyHr,tx=>tx.execute(sql`select app.module_function_legacy_allowed(${b.tenantId}::uuid,${companyHr.userId}::uuid,'function.attendancePolicy.schedule.add',null)`))).rejects.toThrow();
});
it('preserves the separate genuine group-only dated rotation and copy-with-rotations floor',async()=>{
 const group=await createAttendanceRule(companyHr,ruleInput('Fictional ordinary group with rotation')),shift=await createShift(companyHr,shiftInput('Fictional company HR shift'));
 await setRuleShifts(companyHr,{ruleId:group.id,shiftIds:[shift.id]});
 const state=await getScheduleRotation(companyHr,group.id),date=new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+8*86400000).toISOString().slice(0,10);
 const input={ruleId:group.id,expectedRevision:state.revision,allowedShiftIds:[shift.id],cycle:{unit:'day' as const,length:1,effectiveFrom:date,anchorDate:date,days:[{kind:'full' as const,shiftId:shift.id}]}};
 await expect(saveScheduleRotation(companyHr,input)).rejects.toThrow('A group-wide HR administrator is required');
 await saveScheduleRotation(admin,input);expect((await getScheduleRotation(admin,group.id)).versions).toHaveLength(1);
 const before=await owner.db.select().from(s.attendanceRule);await expect(copyAttendanceRule(companyHr,{ruleId:group.id})).rejects.toThrow('A group-wide HR administrator is required to copy');expect(await owner.db.select().from(s.attendanceRule)).toEqual(before);
});

it('retains actual company-HR Shift and child-window courses through copy, replacement and removal',async()=>{
 const input=shiftInput('Fictional source shift'),created=await createShift(companyHr,input);
 await replaceShiftOtWindows(companyHr,{shiftId:created.id,windows:[{label:'Fictional OT',startTime:'17:00',endTime:'18:00'}]});
 const [window]=await listShiftOtWindows(companyHr,created.id);expect(window.label).toBe('Fictional OT');
 await replaceShiftOtWindows(companyHr,{shiftId:created.id,windows:[{id:window.id,label:'Fictional revised OT',startTime:'17:00',endTime:'19:00'}]});expect((await listShiftOtWindows(companyHr,created.id))[0].id).toBe(window.id);
 const copied=await copyShift(companyHr,{shiftId:created.id});expect((await listShiftOtWindows(companyHr,copied.id)).map(row=>row.label)).toEqual(['Fictional revised OT']);
 await updateShift(companyHr,{...input,shiftId:created.id,name:'Fictional source revised'});
 await archiveShift(companyHr,{shiftId:created.id});await unarchiveShift(companyHr,{shiftId:created.id});
 await deleteShift(companyHr,{shiftId:copied.id});expect(await listShiftOtWindows(companyHr,copied.id)).toEqual([]);
 expect((await listShiftsForMaintenance(companyHr)).map(row=>row.id)).toContain(created.id);
 const events=await owner.client`select actor_id,event_type from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${created.id}::uuid order by sequence`;
 expect(events.length).toBeGreaterThan(4);expect(events.every(event=>event.actor_id===companyHr.userId)).toBe(true);
});
it('keeps member routing references independent and denies forged/raw maintenance authority',async()=>{
 const created=await createShift(companyHr,shiftInput('Fictional reference shift')),userId=await createAppUser(b.tenantId,null,'employee'),member:SessionContext={...admin,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 expect((await listShiftsForTenant(member)).map(row=>row.id)).toContain(created.id);expect(await Promise.all((['view','add','edit','delete'] as const).map(operation=>shiftActionAccess(member,operation)))).toEqual([false,false,false,false]);
 await expect(listShiftsForMaintenance(member)).rejects.toThrow('Shift view unavailable');
 await expect(withTenant(member,async tx=>{await tx.execute(sql`select set_config('app.shift_constructor','true',true)`);await tx.delete(s.shift).where(eq(s.shift.id,created.id));})).rejects.toThrow();
 await expect(withTenant(companyHr,tx=>tx.execute(sql`select * from app.shift_constructor_source`))).rejects.toThrow();
 await expect(withTenant(companyHr,tx=>tx.execute(sql`select app.shift_initial_membership_allowed('{}'::jsonb)`))).rejects.toThrow();
 expect((await owner.db.select().from(s.shift).where(eq(s.shift.id,created.id)))[0].name).toBe('Fictional reference shift');
});
it('preserves the real native Shift constructor and its original initial membership in an APP session',async()=>{
 const group=await createAttendanceRule(companyHr,ruleInput('Fictional constructor group'));
 const created=await createShift(companyHr,{...shiftInput('Fictional original constructor'),ruleId:group.id});
 expect(await owner.db.select({ruleId:s.attendanceRuleShift.ruleId,shiftId:s.attendanceRuleShift.shiftId}).from(s.attendanceRuleShift).where(eq(s.attendanceRuleShift.shiftId,created.id))).toEqual([{ruleId:group.id,shiftId:created.id}]);
 const copied=await copyShift(companyHr,{shiftId:created.id});expect(await owner.db.select({ruleId:s.attendanceRuleShift.ruleId}).from(s.attendanceRuleShift).where(eq(s.attendanceRuleShift.shiftId,copied.id))).toEqual([{ruleId:group.id}]);
});
it('binds the original first membership and excludes neighbors or changed/restored parents in an owner-held protocol simulation',async()=>{
 const first=await createAttendanceRule(companyHr,ruleInput('Fictional first group')),neighbor=await createAttendanceRule(companyHr,ruleInput('Fictional neighbor group'));
 // This is private predicate/real-body evidence under an owner-held app-role downgrade, NOT strict APP-login qualification.
 await owner.withTenant(companyHr,async tx=>{
  await tx.execute(sql`set local role ai_hr_app`);
  const [fresh]=await tx.insert(s.shift).values({tenantId:b.tenantId,name:'Fictional finite source',code:randomUUID().slice(0,8),startTime:'08:00',endTime:'17:00',breakMinutes:60,ruleId:first.id}).returning();
  await tx.insert(s.attendanceRuleShift).values({tenantId:b.tenantId,ruleId:first.id,shiftId:fresh.id});
  await tx.insert(s.attendanceRuleShift).values({tenantId:b.tenantId,ruleId:neighbor.id,shiftId:fresh.id});
  const [changed]=await tx.insert(s.shift).values({tenantId:b.tenantId,name:'Fictional changed source',code:randomUUID().slice(0,8),startTime:'08:00',endTime:'17:00',breakMinutes:60,ruleId:first.id}).returning();
  await tx.update(s.shift).set({ruleId:neighbor.id}).where(eq(s.shift.id,changed.id));await tx.update(s.shift).set({ruleId:first.id}).where(eq(s.shift.id,changed.id));
  await tx.insert(s.attendanceRuleShift).values({tenantId:b.tenantId,ruleId:first.id,shiftId:changed.id});
  await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`reset role`);
  const rows=await tx.execute<{shiftId:string;ruleId:string;initial:boolean}>(sql`select shift_id as "shiftId",rule_id as "ruleId",app.shift_initial_membership_allowed(to_jsonb(actual)) as initial from public.attendance_rule_shift actual where shift_id in (${fresh.id}::uuid,${changed.id}::uuid) order by shift_id,rule_id`);
  expect(rows.find(row=>row.shiftId===fresh.id&&row.ruleId===first.id)?.initial).toBe(true);expect(rows.find(row=>row.shiftId===fresh.id&&row.ruleId===neighbor.id)?.initial).toBe(false);expect(rows.find(row=>row.shiftId===changed.id)?.initial).toBe(false);
 });
});

async function changeDataControls(tx:Tx,command:DataPermissionCommand){
 const [state]=await tx.execute<{value:DataPermissionState}>(sql`select app.data_permission_state() as value`);
 const [preview]=await tx.execute<{value:DataPermissionPreview}>(sql`select app.data_permission_transition(${JSON.stringify(command)}::jsonb,${state.value.revision},false,null) as value`);
 expect(preview.value.fingerprint).toBeTruthy();
 await tx.execute(sql`select app.data_permission_transition(${JSON.stringify(command)}::jsonb,${state.value.revision},true,${preview.value.fingerprint})`);
}
it('requeues completed Shift initialization after early flush and actual APP canonical control restore',async()=>{
 const userId=companyHr.userId;if(!userId)throw new Error('The real company HR fixture is missing its user');
 const profileId=randomUUID(),create:DataPermissionCommand={kind:'create',profileId,name:'Fictional Shift proof authority control',enabled:true,rules:{legacyCompany:false,predicates:[{field:'company',values:[b.companyId]},{field:'department',values:[b.deptB]}]}};
 const state=await readDataPermissions(admin),preview=await previewDataPermission(admin,state.revision,create);await saveDataPermission(admin,state.revision,create,preview.fingerprint);
 const assignments=(await readDataPermissions(admin)).assignments,group=await createAttendanceRule(admin,ruleInput('Fictional terminal initialization'));
 let id:string|undefined,failure:unknown;
 try{await withTenant(admin,async tx=>{
  const [session]=await tx.execute<{owner:boolean;app:boolean}>(sql`select pg_has_role(session_user,(select relowner from pg_class where oid='public.app_user'::regclass),'USAGE') as owner,pg_has_role(current_user,'ai_hr_app','USAGE') as app`);expect(session).toEqual({owner:false,app:true});
  const [created]=await tx.insert(s.shift).values({tenantId:b.tenantId,name:'Fictional authority-bound Shift',code:randomUUID().slice(0,8),startTime:'08:00',endTime:'17:00',ruleId:group.id}).returning({id:s.shift.id});id=created.id;
  await tx.insert(s.attendanceRuleShift).values({tenantId:b.tenantId,ruleId:group.id,shiftId:created.id});
  await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`set constraints all deferred`);
  await changeDataControls(tx,{kind:'assign',userId,profileId});
  const [assigned]=await tx.execute<{value:DataPermissionState}>(sql`select app.data_permission_state() as value`);expect(assigned.value.assignments).toContainEqual({userId,profileId});
  await changeDataControls(tx,{kind:'assign',userId,profileId:null});
  const [restored]=await tx.execute<{value:DataPermissionState}>(sql`select app.data_permission_state() as value`);expect(restored.value.assignments).toEqual(assignments);
 });}catch(error){failure=error;}
 let denied=false;for(let cause=failure;cause&&typeof cause==='object';cause=(cause as {cause?:unknown}).cause)if((cause as {code?:string}).code==='42501'&&(cause as {message?:string}).message==='Shift initialization incomplete')denied=true;expect(denied).toBe(true);
 if(!id)throw new Error('The actual Shift source was never constructed');expect(await owner.db.select().from(s.shift).where(eq(s.shift.id,id))).toEqual([]);expect(await owner.db.select().from(s.attendanceRuleShift).where(eq(s.attendanceRuleShift.shiftId,id))).toEqual([]);
 expect((await readDataPermissions(admin)).assignments).toEqual(assignments);
});

it('matches actual stored/current dated-rotation floors and registry delegation without broadening company-HR',async()=>{
 const userId=companyHr.userId;if(!userId)throw new Error('The actual company HR actor is missing');
 expect(await Promise.all((['view','edit'] as const).map(operation=>rotationActionAccess(companyHr,operation)))).toEqual([true,false]);
 expect(await Promise.all((['view','edit'] as const).map(operation=>rotationActionAccess(admin,operation)))).toEqual([true,true]);
 for(const actor of [companyHr,admin]){
  const expected=actor.userId===admin.userId;
  const [floor]=await owner.withTenant(actor,tx=>tx.execute<{stored:boolean;current:boolean;delegation:boolean}>(sql`select app.module_function_legacy_allowed(${b.tenantId}::uuid,${actor.userId}::uuid,'function.attendancePolicy.rotations.edit',null) as stored,app.module_function_current_legacy_allowed(${b.tenantId}::uuid,${actor.userId}::uuid,'function.attendancePolicy.rotations.edit',null) as "current",app.access_function_delegation_floor('function.attendancePolicy.rotations.edit',null) as delegation`));
  expect(floor).toEqual({stored:expected,current:expected,delegation:expected});
 }
 const group=await createAttendanceRule(admin,ruleInput('Fictional raw rotation owner')),shift=await createShift(admin,shiftInput('Fictional raw rotation shift'));
 const date=new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+8*86400000).toISOString().slice(0,10);
 await expect(withTenant(companyHr,tx=>tx.insert(s.attendanceRotation).values({tenantId:b.tenantId,ruleId:group.id,effectiveFrom:date,anchorDate:date,unit:'day',length:1,allowedShiftIds:[shift.id],days:[{kind:'full',shiftId:shift.id}],createdBy:userId}))).rejects.toThrow();
 expect(await owner.db.select().from(s.attendanceRotation).where(eq(s.attendanceRotation.ruleId,group.id))).toEqual([]);
});

it('preserves distinct actual company-HR Duty and Exception courses and immutable forward revisions',async()=>{
 const group=await createAttendanceRule(companyHr,ruleInput('Fictional separate schedule controls'));
 expect(await Promise.all([scheduleControlActionAccess(companyHr,'duty','view'),scheduleControlActionAccess(companyHr,'duty','edit'),scheduleControlActionAccess(companyHr,'exception','edit')])).toEqual([true,true,true]);
 await saveScheduleGroupControl(companyHr,{ruleId:group.id,kind:'duty',enabled:true});await saveScheduleGroupControl(companyHr,{ruleId:group.id,kind:'exception',enabled:true});
 const state=await scheduleGroupControls(companyHr,group.id);expect(state.dutyRosterControl).toBe(true);expect(state.revisions).toHaveLength(1);expect(state.revisions[0].enabled).toBe(true);expect(state.revisions[0].effectiveFrom>todayInKualaLumpur()).toBe(true);
 await expect(saveScheduleGroupControl(companyHr,{ruleId:group.id,kind:'exception',enabled:false})).rejects.toThrow('A saved exception revision already takes effect tomorrow');
 expect((await scheduleGroupControls(companyHr,group.id)).revisions).toEqual(state.revisions);
 const [floors]=await owner.withTenant(companyHr,tx=>tx.execute<{dutyStored:boolean;dutyCurrent:boolean;exceptionStored:boolean;exceptionCurrent:boolean;dutyDelegation:boolean;exceptionDelegation:boolean}>(sql`select app.module_function_legacy_allowed(${b.tenantId}::uuid,${companyHr.userId}::uuid,'function.attendancePolicy.dutyRoster.edit',null) as "dutyStored",app.module_function_current_legacy_allowed(${b.tenantId}::uuid,${companyHr.userId}::uuid,'function.attendancePolicy.dutyRoster.edit',null) as "dutyCurrent",app.module_function_legacy_allowed(${b.tenantId}::uuid,${companyHr.userId}::uuid,'function.attendancePolicy.exceptions.edit',null) as "exceptionStored",app.module_function_current_legacy_allowed(${b.tenantId}::uuid,${companyHr.userId}::uuid,'function.attendancePolicy.exceptions.edit',null) as "exceptionCurrent",app.access_function_delegation_floor('function.attendancePolicy.dutyRoster.edit',null) as "dutyDelegation",app.access_function_delegation_floor('function.attendancePolicy.exceptions.edit',null) as "exceptionDelegation"`));expect(floors).toEqual({dutyStored:true,dutyCurrent:true,exceptionStored:true,exceptionCurrent:true,dutyDelegation:true,exceptionDelegation:true});
});
it('denies raw or stale non-admin switch writes without changing actual control state',async()=>{
 const group=await createAttendanceRule(companyHr,ruleInput('Fictional guarded schedule controls')),userId=await createAppUser(b.tenantId,null,'employee'),member:SessionContext={...admin,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 expect(await scheduleControlActionAccess(member,'duty','edit')).toBe(false);expect(await scheduleControlActionAccess(member,'exception','edit')).toBe(false);
 await expect(withTenant(member,async tx=>{await tx.execute(sql`select set_config('app.schedule_control','true',true)`);await tx.update(s.attendanceRule).set({dutyRosterControl:true}).where(eq(s.attendanceRule.id,group.id));})).rejects.toThrow();
 const date=new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+86400000).toISOString().slice(0,10);
 await expect(withTenant(member,tx=>tx.insert(s.attendanceExceptionRevision).values({tenantId:b.tenantId,ruleId:group.id,effectiveFrom:date,enabled:true,createdBy:userId}))).rejects.toThrow();
 expect(await scheduleGroupControls(companyHr,group.id)).toMatchObject({dutyRosterControl:false,revisions:[]});
 const actorId=companyHr.userId;if(!actorId)throw new Error('The actual company HR actor is missing');
 await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,actorId));
 await expect(saveScheduleGroupControl(companyHr,{ruleId:group.id,kind:'duty',enabled:true})).rejects.toThrow();expect((await owner.db.select().from(s.attendanceRule).where(eq(s.attendanceRule.id,group.id)))[0].dutyRosterControl).toBe(false);
});
