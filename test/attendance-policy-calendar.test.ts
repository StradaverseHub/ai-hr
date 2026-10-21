import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createShift,assignDefaultShift,assignShift} from '../core/roster';
import {attendancePolicyCalendarTx,workedDayKindForTx,attendanceDayEditor,saveAttendanceDayEdit} from '../packs/attendance/service';
import {partitionAttendancePolicyWork} from '../packs/attendance/policy-partition';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext;
const day=(offset=0)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const dow=(date:string)=>new Date(date+'T00:00:00Z').getUTCDay()||7;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);});
async function fixture(){
  const e=await hireEmployee(ctx,{person:{fullName:'Fictional calendar evidence',primaryEmail:randomUUID()+'@fixture.invalid'},
    companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-20)});
  const sh=await createShift(ctx,{code:'CAL_'+randomUUID().slice(0,6),name:'Fictional calendar shift',startTime:'09:00',endTime:'18:00',breakMinutes:60,
    weeklyPattern:[1,2,3,4,5,6,7].filter(n=>![dow(day(1)),dow(day(2))].includes(n)),offPattern:[dow(day(1))]});
  await assignDefaultShift(ctx,{employmentId:e.employmentId,shiftId:sh.id});return {...e,shiftId:sh.id};
}
const read=(employmentId:string,dates:string[],actor=ctx)=>withTenant(actor,tx=>attendancePolicyCalendarTx(tx,{employmentId,dates}));
describe('canonical policy calendar evidence',()=>{
  it('preserves Normal, Off and Rest, and partitions overnight work on their actual dates',async()=>{
    const e=await fixture(),facts=await read(e.employmentId,[day(),day(1),day(2)]);
    expect(facts).toMatchObject([{date:day(),state:'known',dayClass:'normal',moneyDay:'workday'},
      {date:day(1),state:'known',dayClass:'off',moneyDay:'workday'}, {date:day(2),state:'known',dayClass:'rest',moneyDay:'rest_day'}]);
    expect(partitionAttendancePolicyWork({sourceDate:day(1),periodMinutes:2880,splitAtMidnight:true,intervals:[{from:1410,to:1500}],calendar:facts}))
      .toMatchObject({status:'ready',minutes:90,parts:[{date:day(1),dayClass:'off',minutes:30},{date:day(2),dayClass:'rest',minutes:60}]});
    for(const fact of facts)expect(await withTenant(ctx,tx=>workedDayKindForTx(tx,e.employmentId,fact.date)))
      .toBe(fact.state==='known'&&fact.dayClass==='off'?'off_day':fact.state==='known'&&fact.dayClass==='rest'?'rest_day':'workday');
  });
  it('lets a rostered work shift replace Off without removing the canonical holiday premium',async()=>{
    const e=await fixture();await assignShift(ctx,{employmentId:e.employmentId,shiftDate:day(1),shiftId:e.shiftId});
    expect(await read(e.employmentId,[day(1)])).toMatchObject([{state:'known',dayClass:'normal'}]);
    const [holiday]=await owner.db.insert(s.holiday).values({tenantId:b.tenantId,country:'MY',companyId:b.companyId,holidayDate:day(1),name:'Fictional original holiday'}).returning();
    const [fact]=await read(e.employmentId,[day(1)]);expect(fact).toMatchObject({state:'known',dayClass:'publicHoliday',moneyDay:'holiday'});
    expect(fact.state==='known'&&fact.references).toContain(`holiday:${holiday.id}`);
  });
  it('respects a canonical day correction but refuses to invent holiday designation from its generic label',async()=>{
    const e=await fixture(),date=day();
    async function correct(dayKind:'rest_day'|'holiday'){
      const editor=await attendanceDayEditor(ctx,e.employmentId,date);expect(editor).not.toBeNull();
      await saveAttendanceDayEdit(ctx,{employmentId:e.employmentId,date,baseline:editor!.baseline,reason:'Fictional verified day correction',confirmPayrollRecalculation:false,kind:'schedule',shiftId:null,dayKind});
    }
    await correct('rest_day');const [rest]=await read(e.employmentId,[date]);expect(rest).toMatchObject({state:'known',dayClass:'rest'});
    const [adjustment]=await owner.db.select().from(s.attendanceDayAdjustment).where(and(eq(s.attendanceDayAdjustment.employmentId,e.employmentId),eq(s.attendanceDayAdjustment.attendanceDate,date)));
    expect(rest.state==='known'&&rest.references).toContain(`attendance-day-adjustment:${adjustment.id}:${adjustment.version}`);
    await correct('holiday');expect(await read(e.employmentId,[date])).toEqual([{date,state:'unknown',reason:'holidayDesignationUnavailable'}]);
  });
  it('keeps missing tenure, missing assignments, unrelated employees and foreign tenants unknown without evidence identities',async()=>{
    const e=await fixture();expect(await read(e.employmentId,[day(-21)])).toEqual([{date:day(-21),state:'unknown',reason:'calendarUnavailable'}]);
    const ownUser=await createAppUser(b.tenantId,e.personId,'employee');
    const own:SessionContext={...ctx,userId:ownUser,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
    expect(await read(e.employmentId,[day()],own)).toMatchObject([{state:'known',dayClass:'normal'}]);
    const other=await hireEmployee(ctx,{person:{fullName:'Fictional unrelated reader',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-20)});
    const userId=await createAppUser(b.tenantId,other.personId,'employee');
    const self:SessionContext={...ctx,userId,personId:other.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
    for(const actor of [self,adminCtx(await seedBase())])expect(await read(e.employmentId,[day()],actor)).toEqual([{date:day(),state:'unknown',reason:'calendarUnavailable'}]);
    await owner.db.delete(s.assignment).where(eq(s.assignment.employmentId,e.employmentId));
    expect(await read(e.employmentId,[day()])).toEqual([{date:day(),state:'unknown',reason:'calendarUnavailable'}]);
  });
  it('bounds and validates the source timeline before resolving a schedule',async()=>{
    const e=await fixture();expect(await read(e.employmentId,[])).toEqual([]);
    for(const dates of [[day(),day()],[day(),day(3)],['2026-02-30'],[day(),day(1),day(2),day(3)]])await expect(read(e.employmentId,dates)).rejects.toThrow();
  });
});
