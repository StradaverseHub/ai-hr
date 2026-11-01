/** Actual import transactions must overlap for distinct employments before audit append. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {hireEmployee} from '../core/org';
import {commitClockingImport,createClockingMapping,type ClockingMappingInput} from '../core/attendance-clocking-import';
import {employment} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import * as attendanceOwner from '../core/attendance';
import {lockLeaveDependencyConfigurationTx} from '../core/leave-dependency-lock';
beforeAll(migrateTestDb);afterAll(closeAll);
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const mapping:ClockingMappingInput={name:'Concurrency CSV',description:'',deviceName:'Fixture',fileType:'csv',layout:'delimited',delimiter:',',hasHeader:false,encoding:'utf-8',active:true,
 fields:{cardId:{column:1},day:{column:2},month:{column:3},year:{column:4},hours:{column:5},minute:{column:6},inOutCode:{column:7}},
 inOutCodes:[{code:'IN',direction:'in'},{code:'OUT',direction:'out'}],sampleLines:['001,01,07,2026,09,00,IN'],sampleFileName:'sample.csv'};
async function fixture(){
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const hire=async(card:string)=>{
  const h=await hireEmployee(ctx,{person:{fullName:`Fictional import ${card}`,primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01',employeeCode:card});
  await owner.db.update(employment).set({cardId:card}).where(eq(employment.id,h.employmentId));return h;
 };
 const a=await hire('1001'),c=await hire('1002'),m=await createClockingMapping(ctx,mapping);
 let date=new Date(Date.parse(todayInKualaLumpur()+'T12:00:00Z')-7*86400000);
 while([0,6].includes(date.getUTCDay()))date=new Date(date.getTime()-86400000);
 const [year,month,day]=date.toISOString().slice(0,10).split('-');
 const submit=(card:string,fileName:string)=>{
  const text=`${card},${day},${month},${year},09,00,IN\n${card},${day},${month},${year},17,00,OUT`;
  return commitClockingImport(ctx,{mappingId:m,text,fileName,fileBytes:Buffer.byteLength(text)});
 };
 return {b,ctx,a,c,submit};
}
it.each(['unrelated','same-subject','revocation'] as const)('retains native import ownership (%s)',async scenario=>{
 const {b,ctx,a,c,submit}=await fixture();
 const gate='test-import-command:'+randomUUID(),connection=await owner.client.reserve();
 await owner.client.unsafe(`create function public.perf_import_pause() returns trigger language plpgsql as $body$ begin if new.file_name='held.csv' then perform pg_advisory_xact_lock(hashtextextended('${gate}',0)); end if; return new; end $body$; create trigger a_perf_import_pause before insert on clocking_import_run for each row execute function public.perf_import_pause()`);
 type Outcome=Awaited<ReturnType<typeof commitClockingImport>>;
 let first:Promise<Outcome>|undefined,second:Promise<Outcome>|undefined,revoker:Promise<unknown>|undefined,revokePid:number|undefined,reached=false,overlapped=false,revocationWaiting=false;
 try{
  const [pid]=await connection`select pg_backend_pid() as pid`;
  await connection`select pg_advisory_lock(hashtextextended(${gate},0))`;
  first=submit('1001','held.csv');
  const until=Date.now()+3000;
  while(Date.now()<until){
   const [row]=await owner.client`select exists(select 1 from pg_locks where locktype='advisory' and not granted and ${pid.pid}::int=any(pg_blocking_pids(pid)) and classid=((hashtextextended(${gate},0)>>32)&4294967295)::oid and objid=(hashtextextended(${gate},0)&4294967295)::oid) as waiting`;
   if(row.waiting){reached=true;break;}await delay(5);
  }
  if(reached&&scenario==='revocation'){
   revoker=owner.client.begin(async connection=>{const [row]=await connection`select pg_backend_pid() as pid`;revokePid=row.pid;await connection`update app_user set archived_at=now() where id=${ctx.userId!}::uuid`;});
   const until=Date.now()+1500;
   while(Date.now()<until){if(revokePid){const [row]=await owner.client`select exists(select 1 from pg_locks where pid=${revokePid} and locktype='advisory' and not granted) as waiting`;if(row.waiting){revocationWaiting=true;break;}}await delay(5);}
  }else if(reached){second=submit(scenario==='same-subject'?'1001':'1002','other.csv');overlapped=await Promise.race([second.then(r=>r.imported===2&&r.failureReason===null),delay(1500).then(()=>false)]);}
 }finally{
  await connection`select pg_advisory_unlock(hashtextextended(${gate},0))`;connection.release();
 }
 const outcomes=await Promise.all([...(first?[first]:[]),...(second?[second]:[])]);if(revoker)await revoker;
 await owner.client.unsafe('drop trigger a_perf_import_pause on clocking_import_run; drop function public.perf_import_pause()');
 expect(reached,'actual first import physically reaches the native gate before run/audit insertion').toBe(true);
 expect(outcomes[0]).toMatchObject({imported:2,failureReason:null});
 if(scenario==='unrelated')expect(outcomes[1]).toMatchObject({imported:2,failureReason:null});
 if(scenario==='same-subject')expect(outcomes[1]).toMatchObject({imported:0,status:'failed',failureReason:expect.stringContaining('Leave source is unavailable')});
 if(scenario==='revocation'){
  expect(revocationWaiting,'native authority revocation remains excluded through import commit').toBe(true);
  const [row]=await owner.client`select archived_at is not null as archived from app_user where id=${ctx.userId!}::uuid`;expect(row.archived).toBe(true);
  const refused=await submit('1002','revoked.csv');expect(refused).toMatchObject({imported:0,status:'failed'});
 }
 const rows=await owner.client`select employment_id,count(*)::int as n from attendance_punch where tenant_id=${b.tenantId}::uuid and employment_id in (${a.employmentId}::uuid,${c.employmentId}::uuid) group by employment_id order by employment_id`;
 expect(rows).toHaveLength(scenario==='unrelated'?2:1);expect(rows.map(r=>r.n)).toEqual(scenario==='unrelated'?[2,2]:[2]);
 expect(overlapped,'only an unrelated employment may commit before the held import releases authority').toBe(scenario==='unrelated');
});

/** A test-only configuration demand AFTER the real batch writer proves the import boundary replays
 * database work atomically. Real first-use TOIL demand remains covered by the Plan OT suite. */
it.each([false,true])('rolls back the entire import before one exclusive replay (late SQL failure: %s)',async failLate=>{
 const {b,a,submit}=await fixture();let attempts=0;
 const original=attendanceOwner.addImportedPunchesBatchTx;
 const spy=vi.spyOn(attendanceOwner,'addImportedPunchesBatchTx').mockImplementation(async(tx,ctx,p)=>{
  attempts++;const result=await original(tx,ctx,p);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);return result;
 });
 if(failLate)await owner.client.unsafe(`create function public.perf_import_refuse_line() returns trigger language plpgsql as $body$ begin raise exception 'Fictional late import refusal'; end $body$;create trigger a_perf_import_refuse_line before insert on clocking_import_line for each row execute function public.perf_import_refuse_line()`);
 let outcome;
 try{outcome=await submit('1001','replay.csv');}
 finally{spy.mockRestore();if(failLate)await owner.client.unsafe('drop trigger a_perf_import_refuse_line on clocking_import_line;drop function public.perf_import_refuse_line()');}
 expect(attempts,'only the precise configuration demand replays; SQL failure never does').toBe(2);
 expect(outcome).toMatchObject(failLate?{status:'failed',imported:0,counts:{total:2}}:{imported:2,failureReason:null});
 const [stored]=await owner.client`select
  (select count(*)::int from clocking_import_run where tenant_id=${b.tenantId}::uuid) as runs,
  (select count(*)::int from clocking_import_line where tenant_id=${b.tenantId}::uuid) as lines,
  (select count(*)::int from attendance_punch where employment_id=${a.employmentId}::uuid) as punches,
  (select count(*)::int from domain_event where tenant_id=${b.tenantId}::uuid and event_type in ('attendance.imported','attendance-clocking-import.run')) as events`;
 expect(stored).toEqual(failLate?{runs:1,lines:0,punches:0,events:0}:{runs:1,lines:2,punches:2,events:2});
});
