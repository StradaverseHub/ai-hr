/** Actual original native courses and current/stored floor parity; no fabricated supported rows. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createAttendanceRule,updateAttendanceRule,copyAttendanceRule,deleteAttendanceRule,setRuleShifts,type AttendanceRuleInput} from '../core/attendance-rule';
import {createShift,type ShiftInput} from '../core/roster';
import {getScheduleRotation,saveScheduleRotation} from '../core/attendance-rotation';
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
