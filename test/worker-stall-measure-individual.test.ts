/**
 * MEASUREMENT ONLY — branch claude/worker-stall-measure-20261114, never merged (see
 * test/worker-stall-measure-bank-csv.test.ts). Times the import worker's Individual Transaction phases at the
 * maximum file: 2,000 rows (lib/individual-txn-import-contract.ts) validated in one tick and confirmed in one tick
 * (one transaction for the whole confirmation). Each measured call is exactly one `runIndividualImportTick`, the
 * unit the runner wraps in watchdog.enter('individual'). Assertions are sanity only.
 */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {seedPayComponentCatalog} from '../core/pay-components';
import {INDIVIDUAL_IMPORT_HEADERS} from '../lib/payroll-txn-import-schema';
import {buildXlsx} from '../lib/spreadsheet';
import {submitIndividualImportJob,readIndividualImportJob,queueIndividualImportConfirmation} from '../core/individual-import-job';
import {runIndividualImportTick} from '../core/individual-import-worker';
import {TAG,clock,hostLine,summary} from './helpers/worker-stall-measure';

const EMPLOYEES=200,PER_EMPLOYEE=10;
let base:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();});afterAll(closeAll);

describe('MEASUREMENT: import worker Individual Transaction phases at 2,000 rows',()=>{
 it('times the validation and confirmation ticks of a 2,000-row monthly workbook',async()=>{
  hostLine();
  const ctx=adminCtx(base),scopeIds=[base.companyId];
  await clock(`fixture: ${EMPLOYEES} employees`,async()=>{
   for(let i=1;i<=EMPLOYEES;i++){
    const e=await hireEmployee(ctx,{person:{fullName:`Measure Employee ${i}`,primaryEmail:`measure-${i}-${randomUUID()}@example.invalid`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
    await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:4000+i,monthlyAllowance:0,effectiveFrom:'2026-01-01'});
   }
   await seedPayComponentCatalog(ctx);
   await owner.db.insert(schema.payrollCycle).values({tenantId:base.tenantId,companyId:base.companyId,name:'Import Monthly',code:'IMP',runType:'regular'});
  });
  const people=await owner.db.select({code:schema.employment.employeeCode,name:schema.person.fullName}).from(schema.employment)
   .innerJoin(schema.person,eq(schema.person.id,schema.employment.personId))
   .where(and(eq(schema.employment.tenantId,base.tenantId),eq(schema.employment.companyId,base.companyId)));
  const staff=people.filter(p=>p.name.startsWith('Measure Employee '));
  expect(staff).toHaveLength(EMPLOYEES);
  const rows:string[][]=[];
  staff.forEach((p,i)=>{for(let k=1;k<=PER_EMPLOYEE;k++)rows.push([p.code!,p.name,'2026-08','IMP','BONUS',`2026-08-${String(k).padStart(2,'0')}`,'amount','',`${100+k}.${String(i%100).padStart(2,'0')}`,`Measured row ${i}-${k}`]);});
  expect(rows).toHaveLength(2000);
  const content=Buffer.from(await buildXlsx([...INDIVIDUAL_IMPORT_HEADERS.monthly],rows));
  const id=randomUUID();
  expect(await submitIndividualImportJob(ctx,{id,name:'monthly.xlsx',content,method:'monthly',scopeIds})).toBe(id);
  const tick=()=>runIndividualImportTick(owner.client,async session=>({...session,entitlements:ctx.entitlements}));
  expect(await clock('individual tick 1: validate 2,000 rows',tick)).toBe(true);
  const ready=await readIndividualImportJob(ctx,id,scopeIds);
  console.info(`${TAG} after validation: ${JSON.stringify({state:ready?.state,total:ready?.total,failed_rows:ready?.failed_rows,error:ready?.error})}`);
  expect(ready?.state).toBe('ready');
  expect(await queueIndividualImportConfirmation(ctx,id,scopeIds)).toBe(true);
  expect(await clock('individual tick 2: confirm 2,000 rows (one transaction)',tick)).toBe(true);
  const done=await readIndividualImportJob(ctx,id,scopeIds);
  console.info(`${TAG} after confirmation: ${JSON.stringify({state:done?.state,processed:done?.processed,written:done?.written,failed_rows:done?.failed_rows,error:done?.error})}`);
  expect(done?.state).toBe('completed');
  summary('individual');
 },1_080_000);
});
