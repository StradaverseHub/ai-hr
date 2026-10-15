/** DB/row-lock regressions. Source prepared only; requires integrated canonical owner lock. */
import {afterAll,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {validateSectionImport,commitSectionImport} from '../core/import-sections';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
const dateOffset=(days:number)=>{const date=new Date(todayInKualaLumpur()+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);};
const hire=(code:string)=>hireEmployee(adminCtx(b),{person:{fullName:code,primaryEmail:code.toLowerCase()+'@superior.test'},employeeCode:code,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:dateOffset(-30)});
const lines=(id:string)=>owner.db.select().from(s.reportingLine).where(eq(s.reportingLine.subordinateEmploymentId,id)).orderBy(s.reportingLine.id);
const events=(id:string)=>owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.subjectEmploymentId,id),sql`${s.domainEvent.eventType} like 'reporting-line.%'`)).orderBy(s.domainEvent.sequence);
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
describe('Employment section Direct Superior no-op uses the canonical dated edge',()=>{
 it('reimports an unchanged manager as skip without changing edge identity, dates or reporting events',async()=>{
  const employee=await hire('NOP001'),manager=await hire('NOP002'),ctx=adminCtx(b);
  await setReportingLine(ctx,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:dateOffset(-10)});
  const before=await lines(employee.employmentId),audit=await events(employee.employmentId),records=[{employee_code:'NOP001',direct_superior:'NOP002'}];
  const preview=await validateSectionImport(ctx,{section:'employment',records});expect(preview.rows[0]).toMatchObject({verdict:'skip',ok:false,changes:[]});
  const result=await commitSectionImport(ctx,{section:'employment',records});expect(result).toMatchObject({updated:0,skipped:1,failed:[]});
  expect(await lines(employee.employmentId)).toEqual(before);expect(await events(employee.employmentId)).toEqual(audit);
 });
 it('changes a genuine manager via the canonical owner exactly once; retries remain no-op',async()=>{
  const employee=await hire('NOP011'),first=await hire('NOP012'),second=await hire('NOP013'),ctx=adminCtx(b);
  await setReportingLine(ctx,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:first.employmentId,lineType:'administrative',validFrom:dateOffset(-10)});
  const records=[{employee_code:'NOP011',direct_superior:'NOP013'}];
  expect((await commitSectionImport(ctx,{section:'employment',records})).updated).toBe(1);
  const after=await lines(employee.employmentId),audit=await events(employee.employmentId);
  expect(after.filter(row=>row.validTo===null)).toEqual([expect.objectContaining({managerEmploymentId:second.employmentId,validFrom:todayInKualaLumpur()})]);
  expect((await commitSectionImport(ctx,{section:'employment',records})).updated).toBe(0);
  expect(await lines(employee.employmentId)).toEqual(after);expect(await events(employee.employmentId)).toEqual(audit);
 });
 it('respects half-open dates and keeps a scheduled future change when today’s manager is unchanged',async()=>{
  const employee=await hire('NOP021'),first=await hire('NOP022'),future=await hire('NOP023'),ctx=adminCtx(b);
  await setReportingLine(ctx,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:first.employmentId,lineType:'administrative',validFrom:dateOffset(-10)});
  await setReportingLine(ctx,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:future.employmentId,lineType:'administrative',validFrom:dateOffset(10)});
  const before=await lines(employee.employmentId),audit=await events(employee.employmentId);
  const same=[{employee_code:'NOP021',direct_superior:'NOP022'}];
  expect((await validateSectionImport(ctx,{section:'employment',records:same})).rows[0].verdict).toBe('skip');
  expect((await commitSectionImport(ctx,{section:'employment',records:same})).updated).toBe(0);
  const scheduled=[{employee_code:'NOP021',direct_superior:'NOP023'}];
  expect((await validateSectionImport(ctx,{section:'employment',records:scheduled})).rows[0].errors.join(' ')).toMatch(/future Direct Superior/);
  expect((await commitSectionImport(ctx,{section:'employment',records:scheduled})).updated).toBe(0);
  expect(await lines(employee.employmentId)).toEqual(before);expect(await events(employee.employmentId)).toEqual(audit);
 });
 it('refuses ambiguous effective edges instead of choosing the first row',async()=>{
  const employee=await hire('NOP031'),first=await hire('NOP032'),second=await hire('NOP033');
  // Deliberate corrupt legacy fixture: canonical writer itself supersedes instead of creating this.
  await owner.db.insert(s.reportingLine).values([first,second].map(manager=>({tenantId:b.tenantId,subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative' as const,validFrom:dateOffset(-10)})));
  const before=await lines(employee.employmentId),records=[{employee_code:'NOP031',direct_superior:'NOP032'}];
  const preview=await validateSectionImport(adminCtx(b),{section:'employment',records});expect(preview.rows[0].errors.join(' ')).toMatch(/More than one Direct Superior/);
  expect((await commitSectionImport(adminCtx(b),{section:'employment',records})).updated).toBe(0);expect(await lines(employee.employmentId)).toEqual(before);
 });
 it('serializes the empty-edge race on the SAME canonical subordinate PK lock and rechecks before writing',async()=>{
  const employee=await hire('NOP041'),manager=await hire('NOP042'),ctx=adminCtx(b);
  let created!:()=>void,release!:()=>void;const createdSignal=new Promise<void>(resolve=>created=resolve),releaseSignal=new Promise<void>(resolve=>release=resolve);
  const writer=withTenant(ctx,async tx=>{await setReportingLine(ctx,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:dateOffset(-10)},tx);created();await releaseSignal;});
  void writer.catch(()=>created()); // Release the wait signal on setup failure; finally drains both promises.
  let importing:ReturnType<typeof commitSectionImport>|undefined;
  try {
   await createdSignal;
   importing=commitSectionImport(ctx,{section:'employment',records:[{employee_code:'NOP041',direct_superior:'NOP042'}]});
   void importing.catch(()=>undefined);
   // Observable real DB wait, no timing assumption: the import reached the subordinate PK lock
   // while canonical writer's new edge was still invisible to its earlier analysis snapshot.
   let blocked=false;const deadline=Date.now()+5000;
   while(Date.now()<deadline){const rows=await owner.db.execute(sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%employment%' and query ilike '%for update%') as blocked`) as unknown as {blocked:boolean}[];if(rows[0]?.blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
   expect(blocked).toBe(true);release();await writer;
   const before=await lines(employee.employmentId),audit=await events(employee.employmentId);expect(before).toHaveLength(1);
   expect(await importing).toMatchObject({updated:0,skipped:1,failed:[]});
   expect(await lines(employee.employmentId)).toEqual(before);expect(await events(employee.employmentId)).toEqual(audit);
  }finally{release();await Promise.allSettled([writer,...(importing?[importing]:[])]);}
 });
});
