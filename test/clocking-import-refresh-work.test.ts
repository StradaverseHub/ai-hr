/** Real terminal-file import; native observer counts physically redundant trace writes. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {commitClockingImport} from '../core/attendance-clocking-import';
import {hireEmployee} from '../core/org';
import {withTenant} from '../db/client';
import {sql} from 'drizzle-orm';
import {refreshOvertimePatternDaysTx} from '../packs/attendance/service';
import {BUILTIN_MAPPING_ID} from '../lib/clocking-file';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('imports fifty legacy days without rewriting unchanged overtime trace values',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional terminal refresh',primaryEmail:randomUUID()+'@example.invalid'},employeeCode:'PERF-REFRESH',companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 // Fixture observer only: no business function, trigger, grant or permission is replaced.
 await owner.client`create table app.performance_import_update_probe(tenant_id uuid not null,unchanged boolean not null)`;
 await owner.client`revoke all on app.performance_import_update_probe from public,ai_hr_app`;
 await owner.client.unsafe(`create function app.performance_import_update_probe_fn() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
 begin insert into app.performance_import_update_probe(tenant_id,unchanged) values(new.tenant_id,old.calc_trace is not distinct from new.calc_trace);return new;end;$$`);
 await owner.client`revoke all on function app.performance_import_update_probe_fn() from public,ai_hr_app`;
 await owner.client.unsafe('create trigger performance_import_update_probe after update of calc_trace on public.attendance for each row execute function app.performance_import_update_probe_fn()');
 try{
  const dates=Array.from({length:50},(_,i)=>addDaysIso(todayInKualaLumpur(),-i-2));
  const text='staff,time\n'+dates.flatMap(date=>['08:00','17:00'].map(time=>'PERF-REFRESH,'+date+' '+time)).join('\n');
  const start=performance.now(),result=await commitClockingImport(ctx,{mappingId:BUILTIN_MAPPING_ID,text,fileName:'fictional-terminal.csv',fileBytes:Buffer.byteLength(text)}),elapsedMs=performance.now()-start;
  expect(result).toMatchObject({status:'successful',imported:100,daysUpdated:50,failureReason:null});
  const [counts]=await owner.client<{days:number;punches:number;events:number;noop:number;traceUpdates:number}[]>`select
   (select count(*)::int from attendance where tenant_id=${b.tenantId} and employment_id=${hired.employmentId}) as days,
   (select count(*)::int from attendance_punch where tenant_id=${b.tenantId} and employment_id=${hired.employmentId} and voided_at is null) as punches,
   (select count(*)::int from domain_event where tenant_id=${b.tenantId} and subject_employment_id=${hired.employmentId} and event_type='attendance.imported') as events,
   (select count(*)::int from app.performance_import_update_probe where tenant_id=${b.tenantId} and unchanged) as noop,
   (select count(*)::int from app.performance_import_update_probe where tenant_id=${b.tenantId}) as "traceUpdates"`;
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'clocking-import-refresh-work.json'),JSON.stringify({kind:'REAL_IMPORT_REDUNDANT_WRITE_COMPONENT_ONLY',releaseEligible:false,elapsedMs,counts},null,2));
  expect(counts.days).toBe(50);expect(counts.punches).toBe(100);expect(counts.events).toBe(50);
  expect(counts.noop,'import must not issue redundant per-day overtime trace writes').toBe(0);
  // A read-only carrier cannot use absence to opt into this command's no-op fast course.
  // Outside the native writer interval it must retain the canonical scalar refusal.
  await expect(withTenant(ctx,async tx=>{
   await tx.execute(sql`SET TRANSACTION READ ONLY`);
   await refreshOvertimePatternDaysTx(tx,ctx,[{employmentId:hired.employmentId,date:dates[0],reason:'Fictional unsafe carrier probe'}]);
  })).rejects.toThrow();
 }finally{
  await owner.client`drop trigger performance_import_update_probe on public.attendance`;
  await owner.client`drop function app.performance_import_update_probe_fn()`;
  await owner.client`drop table app.performance_import_update_probe`;
 }
});
