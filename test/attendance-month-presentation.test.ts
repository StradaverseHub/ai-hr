import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {withModulePresentationRead} from '../core/module-presentation-read';
import {activateOvertimePattern,createOvertimeCalculationOwner,saveOvertimePatternAssignment,saveOvertimePatternDraft,validateOvertimePatternActivation,type CanonicalOvertimeSnapshot} from '../packs/attendance/overtime-patterns';
import type {OvertimePattern} from '../lib/overtime-pattern-model';
import {pgSqlState} from '../lib/db-error';
import * as s from '../db/schema';
import {attendanceMonthSummary,attendanceMonthSummaryPage} from '../packs/attendance/service';
import {createPolicy,assignPolicy} from '../core/payroll-policy';
import {requestLeave,decideLeave} from '../core/leave';
import {applyLeaveAdjustmentBatch} from '../packs/leave/service';
import {parsePageQuery,paginateRows} from '../lib/pagination';
import {attendanceMonthSummaryOriginal} from './helpers/attendance-month-summary-original';
import {observeNativeRead} from './helpers/native-read-observer';
import {adminCtx,closeAll,createAppUser,ledgerBalance,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const month={month:'2026-05',today:'2026-05-04'};
async function members(b:Base,count:number,hiredOn='2026-05-04'){
 const pp=randomUUID().slice(0,24),ep=randomUUID().slice(0,24);
 await owner.client.begin(async tx=>{
  await tx`insert into person(id,tenant_id,full_name,primary_email)
   select (${pp}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional month '||lpad(n::text,6,'0'),${pp}||n::text||'@example.invalid' from generate_series(1,${count}::integer)n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)
   select (${ep}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${pp}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,'MONTH'||lpad(n::text,6,'0'),${hiredOn}::date from generate_series(1,${count}::integer)n`;
  await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
   select ${b.tenantId}::uuid,(${ep}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,${b.deptA}::uuid,'full_time',${hiredOn}::date from generate_series(1,${count}::integer)n`;
 });
 return Array.from({length:count},(_,i)=>({employmentId:ep+String(i+1).padStart(12,'0'),personId:pp+String(i+1).padStart(12,'0')}));
}
async function fixture(count=30,hiredOn='2026-05-04'){const b=await seedBase();await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');return {b,ctx:adminCtx(b),employees:await members(b,count,hiredOn)};}

it('matches the frozen full owner with exact native page/count/order and independent legacy/unknown OT facts',async()=>{
 const {b,ctx,employees}=await fixture();
 await owner.db.insert(s.attendance).values([
  {tenantId:b.tenantId,employmentId:employees[0].employmentId,attendanceDate:'2026-05-04',status:'present',dayType:'workday',workedMinutes:480,otMinutes:60},
  {tenantId:b.tenantId,employmentId:employees[0].employmentId,attendanceDate:'2026-05-05',status:'late',dayType:'rest_day',workedMinutes:450,otMinutes:20},
  {tenantId:b.tenantId,employmentId:employees[0].employmentId,attendanceDate:'2026-05-06',status:'half_day',dayType:'holiday',workedMinutes:240,otMinutes:0},
  {tenantId:b.tenantId,employmentId:employees[0].employmentId,attendanceDate:'2026-05-07',status:'absent',dayType:'workday',workedMinutes:0,otMinutes:0},
  {tenantId:b.tenantId,employmentId:employees[1].employmentId,attendanceDate:'2026-05-04',status:'present',workedMinutes:480,otMinutes:null},
 ]);
 const expected=await attendanceMonthSummaryOriginal(ctx,{...month,companyIds:[b.companyId]});
 expect(await attendanceMonthSummary(ctx,{...month,companyIds:[b.companyId]})).toEqual(expected);
 const probe=observeNativeRead();let page:Awaited<ReturnType<typeof attendanceMonthSummaryPage>>;
 try{page=await attendanceMonthSummaryPage(ctx,{...month,companyIds:[b.companyId],page:parsePageQuery()});}finally{probe.restore();}
 expect(page!).toEqual(paginateRows(expected,parsePageQuery()));expect(page!.state).toMatchObject({total:30,limit:25,hasNext:true});
 expect(page!.rows[0]).toMatchObject({employmentId:employees[0].employmentId,present:2,late:1,halfDay:1,workedMinutes:1170,otWorkday:60,otRestDay:20,otHoliday:0,
  overtimeSummary:{knownMinutes:{unit:'minutes',numerator:'80',denominator:'1'},legacyDays:4,formulaDays:0,unknownDays:0,complete:true},overtimeCapState:'within'});
 expect(page!.rows[1]).toMatchObject({overtimeSummary:{unknownDays:1,complete:false},overtimeCapState:'unknown'});
 expect(probe.properties).toHaveLength(1);expect(probe.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});expect(probe.state.active).toBe(0);
 const main=probe.queries.filter(q=>q.sql.includes('from "attendance"')&&q.sql.includes('"worked_minutes"'));
 expect(main).toHaveLength(1);expect(main[0].rows).toBe(5);
 const deep=parsePageQuery({page:'1'});expect(await attendanceMonthSummaryPage(ctx,{...month,companyIds:[b.companyId],page:deep})).toEqual(paginateRows(expected,deep));
 for(const size of ['50','100','200','all']){const query=parsePageQuery({size});expect(await attendanceMonthSummaryPage(ctx,{...month,companyIds:[b.companyId],page:query})).toEqual(paginateRows(expected,query));}
 for(const query of [parsePageQuery({page:'99'}),parsePageQuery({page:String(Number.MAX_SAFE_INTEGER),size:'200'})]){
  const emptyProbe=observeNativeRead();try{expect(await attendanceMonthSummaryPage(ctx,{...month,companyIds:[b.companyId],page:query})).toEqual(paginateRows(expected,query));}finally{emptyProbe.restore();}
  expect(emptyProbe.queries.some(q=>q.sql.includes('from "attendance"'))).toBe(false);
 }
});

it('retains exact legacy versus scheduled absence and partial/full approved leave behavior',async()=>{
 const {b,ctx,employees}=await fixture(2);await owner.db.update(s.employment).set({hiredOn:'2026-05-05'}).where(eq(s.employment.id,employees[1].employmentId));
 await owner.db.update(s.assignment).set({validFrom:'2026-05-05'}).where(eq(s.assignment.employmentId,employees[1].employmentId));
 await owner.db.insert(s.attendance).values({tenantId:b.tenantId,employmentId:employees[0].employmentId,attendanceDate:'2026-05-04',status:'absent',dayType:'workday',workedMinutes:0,otMinutes:0});
 await owner.db.update(s.leaveType).set({allowNegativeBalance:true,durations:['full_day','half_day_am']}).where(eq(s.leaveType.id,b.annualLeaveTypeId));
 // Submission's allow-negative switch does not waive the approval floor. Seed
 // positive fixture balance through the existing audited adjustment owner.
 const credit=await applyLeaveAdjustmentBatch(ctx,{leaveTypeIds:[b.annualLeaveTypeId],days:2,effectiveOn:'2026-05-05',
  reason:'Fictional attendance partial/full approval balance',targetMode:'individual',employmentIds:[employees[1].employmentId]});
 expect(credit).toMatchObject({targeted:1,written:1,skipped:0});
 expect(await ledgerBalance(employees[1].employmentId,b.annualLeaveTypeId)).toBe(2);
 const half=await requestLeave(ctx,{employmentId:employees[1].employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:'2026-05-05',endDate:'2026-05-05',durationType:'half_day_am'});
 await decideLeave(ctx,{leaveRequestId:half.leaveRequestId,decision:'approved'});
 const full=await requestLeave(ctx,{employmentId:employees[1].employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:'2026-05-06',endDate:'2026-05-06'});
 await decideLeave(ctx,{leaveRequestId:full.leaveRequestId,decision:'approved'});
 expect(await ledgerBalance(employees[1].employmentId,b.annualLeaveTypeId)).toBe(0.5);
 const p={month:'2026-05',today:'2026-05-06',companyIds:[b.companyId],page:parsePageQuery()};
 const legacy=await attendanceMonthSummaryPage(ctx,p);expect(legacy.rows).toEqual(await attendanceMonthSummaryOriginal(ctx,p));
 expect(legacy.rows[0]).toMatchObject({present:1,absent:2});expect(legacy.rows[1]).toMatchObject({absent:1,leaveDays:1});
 const policy=await createPolicy(ctx,{companyId:b.companyId,name:'Fictional scheduled absence',policyType:'monthly',config:{leave:{deductAbsentDays:true}}});
 for(const employee of employees)await assignPolicy(ctx,{employmentId:employee.employmentId,policyId:policy.id});
 const scheduled=await attendanceMonthSummaryPage(ctx,p);expect(scheduled.rows).toEqual(await attendanceMonthSummaryOriginal(ctx,p));
 expect(scheduled.rows[0]).toMatchObject({present:0,absent:3});expect(scheduled.rows[1]).toMatchObject({absent:0,leaveDays:1});
 expect(await attendanceMonthSummary(ctx,{...p,measurement:'raw'})).toEqual(await attendanceMonthSummaryOriginal(ctx,{...p,measurement:'raw'}));
});

it('preserves empty scope native RLS, future-ended exclusion, native duplicate-name order and person visibility',async()=>{
 const {b,ctx,employees}=await fixture(4);await owner.db.update(s.employment).set({terminatedOn:'2099-12-31'}).where(eq(s.employment.id,employees[3].employmentId));
 await owner.db.update(s.person).set({fullName:'Same fictional name'}).where(eq(s.person.id,employees[1].personId));
 await owner.db.update(s.person).set({fullName:'Same fictional name'}).where(eq(s.person.id,employees[2].personId));
 const expected=await attendanceMonthSummaryOriginal(ctx,month);
 for(const companyIds of [undefined,[],[b.companyId]]){
  const actual=await attendanceMonthSummaryPage(ctx,{...month,companyIds,page:parsePageQuery()});expect(actual.state.total).toBe(3);
  expect(actual.rows.map(row=>row.name)).toEqual(expected.map(row=>row.name));expect(new Set(actual.rows.map(row=>row.employmentId))).toEqual(new Set(expected.map(row=>row.employmentId)));
 }
 const userId=await createAppUser(b.tenantId,employees[0].personId,'employee');const employee:SessionContext={tenantId:b.tenantId,userId,personId:employees[0].personId,roles:['employee']};
 const own=await attendanceMonthSummaryPage(employee,{...month,companyIds:[],page:parsePageQuery()});expect(own.state.total).toBe(1);expect(own.rows.map(row=>row.employmentId)).toEqual([employees[0].employmentId]);
 const foreign=await seedBase();await members(foreign,1);
 expect((await attendanceMonthSummaryPage(ctx,{...month,companyIds:[foreign.companyId],page:parsePageQuery()})).state.total).toBe(0);
});

it('captures page inputs and settles a native borrowed query failure before returning',async()=>{
 const {b,ctx}=await fixture(2),expected=await attendanceMonthSummaryPage(ctx,{...month,companyIds:[b.companyId],page:parsePageQuery()});
 const p={...month,companyIds:[b.companyId],page:parsePageQuery()},pending=attendanceMonthSummaryPage(ctx,p);
 p.companyIds[0]=randomUUID();p.month='2099-01';p.today='2099-01-01';p.page.offset=500;expect(await pending).toEqual(expected);
 const acl=()=>owner.client`select a.grantee::regrole::text as grantee,a.grantor::regrole::text as grantor,a.privilege_type,a.is_grantable
  from pg_class c cross join lateral aclexplode(c.relacl)a where c.oid='public.attendance_policy'::regclass order by grantee,grantor,privilege_type`;
 const before=await acl();expect(before.some(row=>row.grantee==='ai_hr_app'&&row.privilege_type==='SELECT')).toBe(true);
 // Revoke a real fixture-table SELECT to fail one actual borrowed native read
 // while sibling SELECTs have started. Restore and prove the exact effective ACL.
 await owner.client`revoke select on public.attendance_policy from ai_hr_app`;
 const probe=observeNativeRead();let failure:unknown;
 try{await attendanceMonthSummaryPage(ctx,{...month,page:parsePageQuery()});}catch(error){failure=error;}
 finally{probe.restore();await owner.client`grant select on public.attendance_policy to ai_hr_app`;}
 expect(pgSqlState(failure)).toBe('42501');expect(await acl()).toEqual(before);
 expect(probe.queries.some(query=>query.sql.includes('from "attendance_policy"'))).toBe(true);
 expect(probe.state.active).toBe(0);
});

it('hydrates all2000 displayed employees across62000 native cells while the full owner retains its formula limit',async()=>{
 const {b,ctx}=await fixture(2001,'2020-01-01');
 await owner.client`insert into attendance(tenant_id,employment_id,attendance_date,status,day_type,worked_minutes,ot_minutes)
  select e.tenant_id,e.id,d::date,'present','workday',480,1 from employment e cross join generate_series('2026-05-01'::date,'2026-05-31'::date,'1 day'::interval)d where e.tenant_id=${b.tenantId}::uuid`;
 const [counts]=await owner.client`select count(*)::int as rows,sum(worked_minutes)::bigint::text as worked from attendance where tenant_id=${b.tenantId}::uuid`;
 expect(counts).toEqual({rows:62031,worked:'29774880'});
 const probe=observeNativeRead();let page:Awaited<ReturnType<typeof attendanceMonthSummaryPage>>;
 try{page=await attendanceMonthSummaryPage(ctx,{month:'2026-05',today:'2026-05-31',companyIds:[b.companyId],page:parsePageQuery({size:'all'})});}finally{probe.restore();}
 expect(page!.state).toMatchObject({total:2001,limit:2000,truncated:true,from:1,to:2000});expect(page!.rows).toHaveLength(2000);
 expect(page!.rows[0].name).toBe('Fictional month 000001');expect(page!.rows.at(-1)?.name).toBe('Fictional month 002000');
 for(const row of page!.rows)expect(row).toMatchObject({present:31,absent:0,leaveDays:0,workedMinutes:14880,otWorkday:31,over45hWeek:true,overtimeSummary:{knownMinutes:{unit:'minutes',numerator:'31',denominator:'1'},complete:true}});
 const hydration=probe.queries.filter(q=>q.sql.includes('from "attendance"')&&q.sql.includes('"worked_minutes"'));
 expect(hydration.map(q=>q.rows)).toEqual([31000,31000]);expect(probe.properties).toHaveLength(1);expect(probe.state.active).toBe(0);
 await expect(attendanceMonthSummary(ctx,{month:'2026-05',today:'2026-05-31',companyIds:[b.companyId]})).rejects.toThrow('Narrow the overtime record selection.');
 await expect(attendanceMonthSummaryOriginal(ctx,{month:'2026-05',today:'2026-05-31',companyIds:[b.companyId]})).rejects.toThrow('Narrow the overtime record selection.');
},300000);

// Same canonical calculation-owner fixture used by overtime-records-integration;
// no native source/calculation row or selected duration is fabricated here.
async function recordFormulaDay(b:Base,employmentId:string,date:string){const ctx=adminCtx(b),[attendance]=await owner.db.insert(s.attendance).values({tenantId:b.tenantId,employmentId,attendanceDate:date,checkInAt:'09:00:00',checkOutAt:'18:00:00',workedMinutes:480,otMinutes:90,ot15Minutes:90}).returning();const [item]=await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'FORMULA',name:'Formula',kind:'allowance'}).returning();const yes=(id:string)=>({id,type:'constant' as const,value:true});const definition:OvertimePattern={v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'earliest',eligibility:yes('eligible'),eligibleMinutes:{id:'duration',type:'literal',unit:'minutes',value:'60.5'},durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Fixture',description:'Stored read fixture',priority:0,when:yes('rate_when'),timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:item.id,currency:'MYR'},payment:{method:'flat',basis:'day',chargeId:'day_charge',amount:{id:'cash',type:'literal',unit:'money',value:'25.123',currency:'MYR'}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};const saved=await saveOvertimePatternDraft(ctx,{draft:{code:'FORMULA',creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Formula',definition}});const check=await validateOvertimePatternActivation(ctx,{versionId:saved.versionId,expectedRevision:1});await activateOvertimePattern(ctx,{versionId:saved.versionId,expectedRevision:1,validationDigest:check.validationDigest!,effectiveFrom:date});await saveOvertimePatternAssignment(ctx,{versionId:saved.versionId,target:{type:'individual',employmentIds:[employmentId]},priority:1,from:date,to:null});
 const fact=<T>(value:T)=>({state:'known' as const,value,provenance:{owner:'attendance' as const,reference:attendance.id,asOf:date,basis:'recorded' as const}});const snapshot:CanonicalOvertimeSnapshot={resolvedLegacyRuleId:null,referenceDigest:'c'.repeat(64),input:{layer:'raw',sessionGranularity:'recorded',source:{tenantId:b.tenantId,employmentId,attendanceId:attendance.id,date:date,inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)},currency:definition.currency,facts:{employmentId:fact(employmentId),companyId:fact(b.companyId),dayType:fact('workday')},resources:[],approval:{status:'approved',minutes:fact('120'),provenance:{owner:'approval',reference:'approved',asOf:date,basis:'recorded'}},segments:[{id:'segment',sessionId:'session',dayType:fact('workday'),clock:{state:'unknown',reason:'No time-band policy'},rawMinutes:fact('120'),approvedMinutes:fact('120')}]}};const api=createOvertimeCalculationOwner(async()=>snapshot);const result=await withTenant(ctx,async tx=>{const prepared=await api.prepareTx(tx,ctx,{employmentId,date:date});return api.recordTx(tx,ctx,{prepared,expectedCurrentRevision:0});});return {attendance,result};}

it('preserves immutable formula duration, raw allowance fields and the existing RC-only borrowed AI seam',async()=>{
 const date=todayInKualaLumpur(),{b,ctx,employees}=await fixture(1,date);
 await recordFormulaDay(b,employees[0].employmentId,date);
 const p={month:date.slice(0,7),today:date,companyIds:[b.companyId]};
 const expected=await attendanceMonthSummaryOriginal(ctx,p),page=await attendanceMonthSummaryPage(ctx,{...p,page:parsePageQuery()});
 expect(page.rows).toEqual(expected);expect(page.state.total).toBe(1);
 expect(page.rows[0]).toMatchObject({present:1,absent:0,workedMinutes:480,otWorkday:90,
  overtimeSummary:{knownMinutes:{unit:'minutes',numerator:'121',denominator:'2'},formulaDays:1,legacyDays:0,unknownDays:0,complete:true},overtimeCapState:'within'});
 const raw=await attendanceMonthSummary(ctx,{...p,measurement:'raw'});
 expect(raw).toEqual(await attendanceMonthSummaryOriginal(ctx,{...p,measurement:'raw'}));
 expect(raw[0]).toMatchObject({otWorkday:90,overtimeSummary:{knownMinutes:{unit:'minutes',numerator:'90',denominator:'1'},formulaDays:0,legacyDays:1,complete:true}});
 expect(await withTenant(ctx,tx=>attendanceMonthSummary(ctx,p,tx))).toEqual(expected);
 await expect(withModulePresentationRead(ctx,'attendance',tx=>attendanceMonthSummary(ctx,p,tx))).rejects.toThrow('calling authority');
});

it('preserves native invalid-month errors on nonempty past-end pages while empty scopes remain empty',async()=>{
 const b=await seedBase();await setModule(b.tenantId,'attendance','active');const ctx=adminCtx(b),page=parsePageQuery({page:'99'});
 for(const invalid of ['2026-00','2026-13','0000-05']){
  expect(await attendanceMonthSummaryOriginal(ctx,{month:invalid})).toEqual([]);
  const empty=await attendanceMonthSummaryPage(ctx,{month:invalid,page});expect(empty.state.total).toBe(0);expect(empty.rows).toEqual([]);
 }
 await members(b,1);
 const nativeCode=async(read:()=>Promise<unknown>)=>{try{await read();return undefined;}catch(error){return pgSqlState(error);}};
 for(const invalid of ['2026-00','2026-13','0000-05']){
  const expected=await nativeCode(()=>attendanceMonthSummaryOriginal(ctx,{month:invalid}));expect(['22007','22008']).toContain(expected);
  for(const requested of [parsePageQuery(),page])expect(await nativeCode(()=>attendanceMonthSummaryPage(ctx,{month:invalid,page:requested}))).toBe(expected);
 }
 const probe=observeNativeRead();try{expect((await attendanceMonthSummaryPage(ctx,{...month,page})).rows).toEqual([]);}finally{probe.restore();}
 expect(probe.queries.some(q=>q.sql.includes('as "monthStart"'))).toBe(false);
 await expect(attendanceMonthSummaryOriginal(ctx,{month:'not-month'})).rejects.toThrow(RangeError);
 await expect(attendanceMonthSummaryPage(ctx,{month:'not-month',page})).rejects.toThrow(RangeError);
});
