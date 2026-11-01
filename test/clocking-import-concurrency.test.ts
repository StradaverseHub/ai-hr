/** Actual import transactions must overlap for distinct employments before audit append. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {hireEmployee} from '../core/org';
import {commitClockingImport,createClockingMapping,type ClockingMappingInput} from '../core/attendance-clocking-import';
import {employment} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
beforeAll(migrateTestDb);afterAll(closeAll);
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const mapping:ClockingMappingInput={name:'Concurrency CSV',description:'',deviceName:'Fixture',fileType:'csv',layout:'delimited',delimiter:',',hasHeader:false,encoding:'utf-8',active:true,
 fields:{cardId:{column:1},day:{column:2},month:{column:3},year:{column:4},hours:{column:5},minute:{column:6},inOutCode:{column:7}},
 inOutCodes:[{code:'IN',direction:'in'},{code:'OUT',direction:'out'}],sampleLines:['001,01,07,2026,09,00,IN'],sampleFileName:'sample.csv'};
it('commits an unrelated native import while the first holds its pre-insert gate',async()=>{
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
 const gate='test-import-command:'+randomUUID(),connection=await owner.client.reserve();
 await owner.client.unsafe(`create function public.perf_import_pause() returns trigger language plpgsql as $body$ begin if new.file_name='held.csv' then perform pg_advisory_xact_lock(hashtextextended('${gate}',0)); end if; return new; end $body$; create trigger a_perf_import_pause before insert on clocking_import_run for each row execute function public.perf_import_pause()`);
 type Outcome=Awaited<ReturnType<typeof commitClockingImport>>;
 let first:Promise<Outcome>|undefined,second:Promise<Outcome>|undefined,reached=false,overlapped=false;
 try{
  const [pid]=await connection`select pg_backend_pid() as pid`;
  await connection`select pg_advisory_lock(hashtextextended(${gate},0))`;
  first=submit('1001','held.csv');
  const until=Date.now()+3000;
  while(Date.now()<until){
   const [row]=await owner.client`select exists(select 1 from pg_locks where locktype='advisory' and not granted and ${pid.pid}::int=any(pg_blocking_pids(pid)) and classid=((hashtextextended(${gate},0)>>32)&4294967295)::oid and objid=(hashtextextended(${gate},0)&4294967295)::oid) as waiting`;
   if(row.waiting){reached=true;break;}await delay(5);
  }
  if(reached){second=submit('1002','other.csv');overlapped=await Promise.race([second.then(r=>r.imported===2&&r.failureReason===null),delay(1500).then(()=>false)]);}
 }finally{
  await connection`select pg_advisory_unlock(hashtextextended(${gate},0))`;connection.release();
 }
 const outcomes=await Promise.all([...(first?[first]:[]),...(second?[second]:[])]);
 await owner.client.unsafe('drop trigger a_perf_import_pause on clocking_import_run; drop function public.perf_import_pause()');
 expect(reached,'actual first import physically reaches the native gate before run/audit insertion').toBe(true);
 expect(outcomes).toEqual([expect.objectContaining({imported:2,failureReason:null}),expect.objectContaining({imported:2,failureReason:null})]);
 const rows=await owner.client`select employment_id,count(*)::int as n from attendance_punch where tenant_id=${b.tenantId}::uuid and employment_id in (${a.employmentId}::uuid,${c.employmentId}::uuid) group by employment_id order by employment_id`;
 expect(rows).toHaveLength(2);expect(rows.map(r=>r.n)).toEqual([2,2]);
 expect(overlapped,'an unrelated employment must commit before the held import releases its tenant authority').toBe(true);
});
