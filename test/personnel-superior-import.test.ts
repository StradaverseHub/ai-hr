/** Dated Movement replaces the undated Employment relationship updater. */
import {afterAll,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {createMovementEvent,movementHistory} from '../core/movement';
import {previewMovementImport,commitMovementImport} from '../core/movement-import';
import type {MovementImportPreview} from '../lib/movement-import-contract';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
const dateOffset=(days:number)=>{const date=new Date(todayInKualaLumpur()+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);};
const hire=(code:string)=>hireEmployee(adminCtx(b),{person:{fullName:code,primaryEmail:code.toLowerCase()+'@superior.test'},employeeCode:code,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:dateOffset(-30)});
const lines=(id:string)=>owner.db.select().from(s.reportingLine).where(eq(s.reportingLine.subordinateEmploymentId,id)).orderBy(s.reportingLine.id);
const events=(id:string)=>owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.subjectEmploymentId,id),sql`${s.domainEvent.eventType} like 'reporting-line.%'`)).orderBy(s.domainEvent.sequence);
const file=(code:string,manager:string)=>toCsv([['employee_code','event_type','effective_date','manager_employment_id'],[code,'reportingLineChange',todayInKualaLumpur(),manager]]);
const preview=(text:string)=>previewMovementImport(adminCtx(b),{companyId:b.companyId,csv:text});
const commit=(csv:string,value:MovementImportPreview)=>commitMovementImport(adminCtx(b),{companyId:b.companyId,csv,selection:value.selection,inputHash:value.inputHash,fingerprints:Object.fromEntries(value.employees.filter(row=>row.fingerprint).map(row=>[row.employeeCode,row.fingerprint!])),acknowledgeExcluded:true});
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
describe('Movement Direct Superior uses the canonical dated edge',()=>{
 it('refuses an unchanged manager without changing edge identity, dates or reporting events',async()=>{
  const employee=await hire('NOP001'),manager=await hire('NOP002'),ctx=adminCtx(b);
  await setReportingLine(ctx,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:dateOffset(-10)});
  const before=await lines(employee.employmentId),audit=await events(employee.employmentId),text=file('NOP001','NOP002');
  const value=await preview(text);expect(value.valid).toBe(0);expect(value.employees[0].rows[0].status).toBe('invalid');
  expect((await commit(text,value)).imported).toBe(0);expect(await lines(employee.employmentId)).toEqual(before);expect(await events(employee.employmentId)).toEqual(audit);
 });
 it('changes a genuine manager via the canonical owner exactly once; a fresh retry is a no-op refusal',async()=>{
  const employee=await hire('NOP011'),first=await hire('NOP012'),second=await hire('NOP013'),ctx=adminCtx(b);
  await setReportingLine(ctx,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:first.employmentId,lineType:'administrative',validFrom:dateOffset(-10)});
  const text=file('NOP011','NOP013'),value=await preview(text);expect(value.valid).toBe(1);expect((await commit(text,value)).imported).toBe(1);
  const after=await lines(employee.employmentId),audit=await events(employee.employmentId);expect(after.filter(row=>row.validTo===null)).toEqual([expect.objectContaining({managerEmploymentId:second.employmentId,validFrom:todayInKualaLumpur()})]);
  expect((await preview(text)).valid).toBe(0);expect((await commit(text,value)).imported).toBe(0);expect(await lines(employee.employmentId)).toEqual(after);expect(await events(employee.employmentId)).toEqual(audit);
 });
 it('keeps a canonical scheduled future manager change when today’s manager is unchanged',async()=>{
  const employee=await hire('NOP021'),first=await hire('NOP022'),future=await hire('NOP023'),ctx=adminCtx(b);
  await setReportingLine(ctx,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:first.employmentId,lineType:'administrative',validFrom:dateOffset(-10)});
  await createMovementEvent(ctx,{employmentId:employee.employmentId,kind:'reportingLineChange',managerEmploymentId:future.employmentId,effectiveDate:dateOffset(10)});
  const before=await lines(employee.employmentId),audit=await events(employee.employmentId);expect((await preview(file('NOP021','NOP022'))).valid).toBe(0);
  expect((await movementHistory(ctx,employee.employmentId)).filter(row=>row.scheduled&&row.status==='pending')).toHaveLength(1);
  expect(await lines(employee.employmentId)).toEqual(before);expect(await events(employee.employmentId)).toEqual(audit);
 });
 it('refuses ambiguous open edges instead of choosing the first row',async()=>{
  const employee=await hire('NOP031'),first=await hire('NOP032'),second=await hire('NOP033');
  await owner.db.insert(s.reportingLine).values([first,second].map(manager=>({tenantId:b.tenantId,subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative' as const,validFrom:dateOffset(-10)})));
  const before=await lines(employee.employmentId),value=await preview(file('NOP031','NOP032'));expect(value.valid).toBe(0);expect(value.employees[0].rows[0].errors).toContain('ambiguous_current_records');expect(await lines(employee.employmentId)).toEqual(before);
 });
 it('serializes the empty-edge race on the canonical subordinate lock and rechecks the committed owner state',async()=>{
  const employee=await hire('NOP041'),manager=await hire('NOP042'),ctx=adminCtx(b);
  let created!:()=>void,release!:()=>void;const createdSignal=new Promise<void>(resolve=>created=resolve),releaseSignal=new Promise<void>(resolve=>release=resolve);
  const writer=withTenant(ctx,async tx=>{await setReportingLine(ctx,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:dateOffset(-10)},tx);created();await releaseSignal;});
  void writer.catch(()=>created());let checking:ReturnType<typeof preview>|undefined;
  try{
   await createdSignal;checking=preview(file('NOP041','NOP042'));void checking.catch(()=>undefined);
   let blocked=false;const deadline=Date.now()+900;
   while(Date.now()<deadline){const rows=await owner.db.execute(sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%employment%' and query ilike '%for update%') as blocked`) as unknown as {blocked:boolean}[];if(rows[0]?.blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
   expect(blocked).toBe(true);release();await writer;const before=await lines(employee.employmentId),audit=await events(employee.employmentId);expect(before).toHaveLength(1);
   expect((await checking).valid).toBe(0);expect(await lines(employee.employmentId)).toEqual(before);expect(await events(employee.employmentId)).toEqual(audit);
  }finally{release();await Promise.allSettled([writer,...(checking?[checking]:[])]);}
 });
});
