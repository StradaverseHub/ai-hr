/** Real row-lock/merge regressions: no UI or action mock can make independent writes pass. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';
import {createAttendanceRule,getAttendanceRule,updateAttendanceRuleSection,type AttendanceRuleInput,type AttendanceRuleView} from '../core/attendance-rule';
let b: Base;
beforeAll(async()=>{await migrateTestDb();});
afterAll(async()=>{await closeAll();});
beforeEach(async()=>{await resetDb();b=await seedBase();});
const input=():AttendanceRuleInput=>({name:`Sections ${randomUUID()}`,description:'Original',status:'active',
  lateGracePeriodMinutes:5,lateAfterMinutes:0,lateDeductMinutes:0,includeGraceInLateness:false,
  earlyGracePeriodMinutes:0,earlyAfterMinutes:0,earlyDeductMinutes:0,includeGraceInEarlyOut:false,
  applyToEarlyOt:false,applyDeductions:false,weeklyPattern:[1],halfPattern:[2],offPattern:[3],
  otRows:[{fromMinutes:0,toMinutes:0,ratePattern:'flat',rate:1.5,phRate:2,roundingMode:'down',roundToMinutes:15}]});
const general=(rule:AttendanceRuleView)=>({ruleId:rule.id,section:'general' as const,
  name:`Renamed ${randomUUID()}`,description:'General edit',status:'active' as const,applyDeductions:true,
  // A stale/crafted full editor payload contains rounding and early values. The service ignores them.
  applyToEarlyOt:false,lateGracePeriodMinutes:0,weeklyPattern:[7],
  otRows:rule.otRows.map(row=>({...row,rate:Number(row.rate),phRate:row.phRate==null?null:Number(row.phRate)}))});
const overtime=(ruleId:string)=>({ruleId,section:'overtime' as const,applyToEarlyOt:true,
  bands:[{fromMinutes:0,toMinutes:0,ratePattern:'flat' as const,rate:1.5,phRate:2,roundingMode:'up' as const,roundToMinutes:30}]});

describe('atomic Schedule Group section ownership',()=>{
  it('a stale General save preserves successful Attendance/Overtime changes and the week',async()=>{
    const ctx=adminCtx(b);const {id}=await createAttendanceRule(ctx,input());
    const stale=(await getAttendanceRule(ctx,id))!;
    await updateAttendanceRuleSection(ctx,{ruleId:id,section:'attendance',fields:{lateGracePeriodMinutes:9,includeGraceInLateness:true}});
    await updateAttendanceRuleSection(ctx,overtime(id));
    const change=general(stale);change.otRows[0].rate=2;await updateAttendanceRuleSection(ctx,change);
    const after=(await getAttendanceRule(ctx,id))!;
    expect(after.name).toBe(change.name);expect(after.applyDeductions).toBe(true);
    expect(after.lateGracePeriodMinutes).toBe(9);expect(after.includeGraceInLateness).toBe(true);
    expect(after.applyToEarlyOt).toBe(true);expect(after.otRows[0].rate).toBe('2.00');expect(after.otRows[0].roundingMode).toBe('up');expect(after.otRows[0].roundToMinutes).toBe(30);
    expect([after.weeklyPattern,after.halfPattern,after.offPattern]).toEqual([[1],[2],[3]]);
  });

  it('concurrent General, Attendance and Overtime saves retain all independent changes',async()=>{
    const ctx=adminCtx(b);const {id}=await createAttendanceRule(ctx,input());const stale=(await getAttendanceRule(ctx,id))!;
    const change=general(stale);
    await Promise.all([updateAttendanceRuleSection(ctx,change),
      updateAttendanceRuleSection(ctx,{ruleId:id,section:'attendance',fields:{earlyGracePeriodMinutes:11,includeGraceInEarlyOut:true}}),
      updateAttendanceRuleSection(ctx,overtime(id))]);
    const after=(await getAttendanceRule(ctx,id))!;
    expect(after.name).toBe(change.name);expect(after.applyDeductions).toBe(true);
    expect(after.earlyGracePeriodMinutes).toBe(11);expect(after.includeGraceInEarlyOut).toBe(true);
    expect(after.applyToEarlyOt).toBe(true);expect(after.otRows[0].roundingMode).toBe('up');expect(after.otRows[0].roundToMinutes).toBe(30);
  });

  it('refuses a stale Overtime key set after General reshapes its ladder; new bands start without rounding',async()=>{
    const ctx=adminCtx(b);const {id}=await createAttendanceRule(ctx,input());
    await updateAttendanceRuleSection(ctx,overtime(id));
    const current=(await getAttendanceRule(ctx,id))!;
    await updateAttendanceRuleSection(ctx,{...general(current),otRows:[
      {fromMinutes:0,toMinutes:60,ratePattern:'flat',rate:1.5,phRate:null},
      {fromMinutes:61,toMinutes:0,ratePattern:'flat',rate:2,phRate:null}]});
    const before=(await getAttendanceRule(ctx,id))!;
    expect(before.otRows.map(row=>[row.fromMinutes,row.roundingMode,row.roundToMinutes])).toEqual([[0,'up',30],[61,'none',null]]);
    await expect(updateAttendanceRuleSection(ctx,overtime(id))).rejects.toThrow('The overtime bands changed');
    expect(await getAttendanceRule(ctx,id)).toEqual(before);
  });

  it.each(['end','pattern','rate'] as const)('refuses an old Overtime identity after General changes the same-from band %s',async change=>{
    const ctx=adminCtx(b);const {id}=await createAttendanceRule(ctx,input());const current=(await getAttendanceRule(ctx,id))!;
    const update=general(current);
    if(change==='end')update.otRows[0].toMinutes=60;
    if(change==='pattern')update.otRows[0].ratePattern='variable';
    if(change==='rate')update.otRows[0].rate=2;
    await updateAttendanceRuleSection(ctx,update);const before=await getAttendanceRule(ctx,id);
    await expect(updateAttendanceRuleSection(ctx,overtime(id))).rejects.toThrow('The overtime bands changed');
    expect(await getAttendanceRule(ctx,id)).toEqual(before);
  });

  it('does not allow a crafted Attendance patch to reach another section or another tenant',async()=>{
    const ctx=adminCtx(b);const {id}=await createAttendanceRule(ctx,input());
    const fields={lateGracePeriodMinutes:8,name:'Injected',applyDeductions:true,applyToEarlyOt:true,weeklyPattern:[7],otRows:[]};
    await updateAttendanceRuleSection(ctx,{ruleId:id,section:'attendance',fields});
    const after=(await getAttendanceRule(ctx,id))!;
    expect(after.lateGracePeriodMinutes).toBe(8);expect(after.name).not.toBe('Injected');
    expect(after.applyDeductions).toBe(false);expect(after.applyToEarlyOt).toBe(false);expect(after.otRows).toHaveLength(1);
    const other=await seedBase();
    await expect(updateAttendanceRuleSection(adminCtx(other),{ruleId:id,section:'attendance',fields:{lateGracePeriodMinutes:99}})).rejects.toThrow();
    expect(await getAttendanceRule(ctx,id)).toEqual(after);
  });
});
