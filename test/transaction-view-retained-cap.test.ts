/**
 * Production 2026-11-15/16: Transaction View (History is the landing tab, "All companies", no period) showed
 * "This page could not be displayed". The live payslip read was capped (862ed0ad), but the retained
 * information-correction documents were read in full and `informationPayslipDocuments` refuses above 5,000.
 *
 * The capped landing read must take the newest documents under the same cap and never refuse. Uncapped
 * readers keep the refusal rather than silently returning a partial set.
 *
 * Production 2026-11-23: the History "Export to Excel" was such an uncapped reader, so "All processed payroll" failed
 * on every attempt (about 17,000 retained documents). The workbook job now reads through
 * `readProcessedPayslipsForExport`, one period at a time, splitting a period by company when needed.
 */
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import * as schema from '../db/schema';
import {listProcessedPayslipsAcross,readProcessedPayslipsForExport} from '../core/payroll-view';
import {RETAINED_DOCUMENT_CEILING} from '../core/information-correction-history';

let b:Base;
beforeAll(()=>migrateTestDb());
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(()=>closeAll());

const PERIODS=['2025-01','2025-02','2025-03'];
const RUNS_PER_PERIOD=1700; // 3 × 1,700 = 5,100 retained documents, above the 5,000 ceiling

/** Closed payslips for one employment on `companyId`'s payroll runs — `runs` per period, each with a retained
 * information snapshot. Set-based SQL. The person is hired into the base company (positions are company-scoped);
 * the runs, payslips and snapshots belong to `companyId`, which is what every read here filters on. */
async function retainedRuns(companyId:string,name:string,code:string,periods:string[],runs:number){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2024-01-15'});
 await owner.db.update(schema.employment).set({employeeCode:code}).where(eq(schema.employment.id,hired.employmentId));
 for(const period of periods){
  const [pp]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId,period,status:'closed'}).returning();
  await owner.db.execute(sql`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,batch_date,status,released_at,run_type,run_seq)
   select ${b.tenantId}::uuid,${companyId}::uuid,${pp.id}::uuid,${period},${period+'-25'}::date,'closed',now(),'bonus',g from generate_series(1,${runs}) g`);
 }
 await owner.db.execute(sql`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,statutory,total_deductions,net_pay,employer_cost)
  select ${b.tenantId}::uuid,pb.id,${hired.employmentId}::uuid,'3000.00','3000.00','{}'::jsonb,'0.00','3000.00','3000.00' from payroll_batch pb where pb.company_id=${companyId}::uuid`);
 await owner.db.execute(sql`insert into information_payslip_snapshot(payslip_id,tenant_id,employment_id,company_id,grade,employment_type,hired_on,join_date,document_metadata,recorded_by)
  select p.id,${b.tenantId}::uuid,${hired.employmentId}::uuid,${companyId}::uuid,null,'full_time','2024-01-15',null,
   jsonb_build_object('employeeName',${name}::text,'employeeCode',${code}::text,'company','Retained Co','currency','MYR'),${b.adminUserId}::uuid
  from payslip p where p.employment_id=${hired.employmentId}::uuid`);
 const [{n}]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from information_payslip_snapshot where employment_id=${hired.employmentId}::uuid`);
 expect(n).toBe(periods.length*runs);
}

/** 5,100 closed payslips for one employment, each with a retained information snapshot. */
async function retainedHistory(){
 await retainedRuns(b.companyId,'Aisha Fixture','EMP-001',PERIODS,RUNS_PER_PERIOD);
 expect(PERIODS.length*RUNS_PER_PERIOD).toBeGreaterThan(RETAINED_DOCUMENT_CEILING);
}

describe('Transaction View landing read with more than 5,000 retained documents', ()=>{
 it('the capped History read returns the newest rows instead of failing', {timeout:120_000}, async()=>{
  await retainedHistory();
  // The landing tab asks for HISTORY_ROW_CAP + 1 = 201 rows.
  const rows=await listProcessedPayslipsAcross(adminCtx(b),{companyIds:[b.companyId],limit:201});
  expect(rows).toHaveLength(201);
  // Independent expectation: newest period first, then run sequence ascending.
  expect(rows.map(r=>`${r.payPeriod}#${r.runSeq}`)).toEqual(Array.from({length:201},(_,i)=>`2025-03#${i+1}`));
  expect(new Set(rows.map(r=>r.id)).size).toBe(201);
 });

 it('an uncapped read still refuses above the ceiling, and a narrowed one still succeeds', {timeout:120_000}, async()=>{
  await retainedHistory();
  await expect(listProcessedPayslipsAcross(adminCtx(b),{companyIds:[b.companyId]})).rejects.toThrow('Narrow the payroll period to view retained documents.');
  const march=await listProcessedPayslipsAcross(adminCtx(b),{companyIds:[b.companyId],year:2025,month:3});
  expect(march).toHaveLength(RUNS_PER_PERIOD);
  expect(march.every(r=>r.payPeriod==='2025-03')).toBe(true);
 });

 it('the History workbook reader returns every row, period by period, in the unsliced order', {timeout:120_000}, async()=>{
  await retainedHistory();
  const rows=await readProcessedPayslipsForExport(adminCtx(b),{companyIds:[b.companyId]});
  // Independent expectation: newest period first, then run sequence ascending, nothing dropped or repeated.
  const expected=[...PERIODS].reverse().flatMap(period=>Array.from({length:RUNS_PER_PERIOD},(_,i)=>`${period}#${i+1}`));
  expect(rows).toHaveLength(PERIODS.length*RUNS_PER_PERIOD);
  expect(rows.map(r=>`${r.payPeriod}#${r.runSeq}`)).toEqual(expected);
  expect(new Set(rows.map(r=>r.id)).size).toBe(rows.length);
  // The screen's filters still narrow it.
  const february=await readProcessedPayslipsForExport(adminCtx(b),{companyIds:[b.companyId],year:2025,month:2});
  expect(february.map(r=>r.payPeriod)).toEqual(Array(RUNS_PER_PERIOD).fill('2025-02'));
 });

 it('one period over the ceiling across two companies is split by company and merged in order', {timeout:180_000}, async()=>{
  // "All companies": 2,600 + 2,600 = 5,200 retained documents in ONE period, each company under the ceiling.
  const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Retained Second Co'}).returning({id:schema.company.id});
  const RUNS=2600;
  await retainedRuns(b.companyId,'Aisha Fixture','EMP-001',['2025-04'],RUNS);
  await retainedRuns(other.id,'Bilal Fixture','EMP-002',['2025-04'],RUNS);
  const scope=[b.companyId,other.id];
  await expect(listProcessedPayslipsAcross(adminCtx(b),{companyIds:scope})).rejects.toThrow('Narrow the payroll period to view retained documents.');
  const rows=await readProcessedPayslipsForExport(adminCtx(b),{companyIds:scope});
  expect(rows).toHaveLength(2*RUNS);
  expect(rows.map(r=>`${r.runSeq}:${r.employeeName}`)).toEqual(
   Array.from({length:RUNS},(_,i)=>[`${i+1}:Aisha Fixture`,`${i+1}:Bilal Fixture`]).flat());
  expect(new Set(rows.map(r=>r.id)).size).toBe(rows.length);
 });
});
