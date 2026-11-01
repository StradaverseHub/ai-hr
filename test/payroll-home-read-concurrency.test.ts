/** Real processing must not monopolize unrelated ordinary commands in the tenant. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {hireEmployee,setReportingLine} from '../core/org';
import {setCompensation} from '../core/comp';
import {requirePackFor} from '../localization/registry';
import {createBatch,generatePayslips} from '../packs/payroll/service';
import {readEmployeeHomeIdentity} from '../core/employee-home';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,createAppUser,harnessSnapshot} from './harness';
import * as s from '../db/schema';
beforeAll(migrateTestDb);afterAll(closeAll);
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
it('reads actual employee Home identity while real Payroll is paused before its first payslip and audit append',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'payroll','active');
 const ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]},today=todayInKualaLumpur();
 const hiredOn=String(Number(today.slice(0,4))-1)+'-01-01',month=new Date(Date.parse(today.slice(0,7)+'-01T12:00:00Z')-86400000).toISOString().slice(0,7);
 const worker=async(name:string,hiredOn:string)=>hireEmployee(ctx,{person:{fullName:name,primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn});
 const a=await worker('Fictional Payroll calculation subject',hiredOn),c=await worker('Fictional concurrent Leave subject',today);
 await setCompensation(ctx,{employmentId:a.employmentId,basicSalary:5000,effectiveFrom:hiredOn});
 await requirePackFor('MY').statutory.set(ctx,{personId:a.personId,icNumber:'900101019665'});
 await setReportingLine(ctx,{subordinateEmploymentId:c.employmentId,managerEmploymentId:a.employmentId,lineType:'administrative',validFrom:today});
 await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:c.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'20.00',effectiveOn:today.slice(0,4)+'-01-01'});
 const homeCtx={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,c.personId,'employee'),personId:c.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 const {batchId}=await createBatch(ctx,{companyId:b.companyId,payPeriod:month});
 let date=new Date(Date.parse(today+'T12:00:00Z')+3*86400000).toISOString().slice(0,10);
 while([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))date=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
 const gate='test-payroll-command:'+randomUUID(),connection=await owner.client.reserve();
 await owner.client.unsafe(`create function public.perf_payroll_pause() returns trigger language plpgsql as $body$ begin if new.batch_id='${batchId}'::uuid then perform pg_advisory_xact_lock(hashtextextended('${gate}',0)); end if; return new; end $body$; create trigger a_perf_payroll_pause before insert on payslip for each row execute function public.perf_payroll_pause()`);
 const settle=(promise:Promise<unknown>)=>promise.then(()=>({ok:true}),error=>({ok:false,error}));
 let first:ReturnType<typeof settle>|undefined,second:ReturnType<typeof settle>|undefined,reached=false,overlap=false;
 try{
  await connection`select pg_advisory_lock(hashtextextended(${gate},0))`;
  first=settle(generatePayslips(ctx,{batchId}));
  const until=Date.now()+4000;
  while(Date.now()<until){const [row]=await owner.client`select exists(select 1 from pg_locks where locktype='advisory' and not granted and classid=((hashtextextended(${gate},0)>>32)&4294967295)::oid and objid=(hashtextextended(${gate},0)&4294967295)::oid) as waiting`;if(row.waiting){reached=true;break;}await delay(3);}
  if(reached){second=settle(readEmployeeHomeIdentity(homeCtx).then(identity=>{expect(identity.selectedEmploymentId).toBe(c.employmentId);}));overlap=await Promise.race([second.then(result=>result.ok),delay(200).then(()=>false)]);}
 }finally{await connection`select pg_advisory_unlock(hashtextextended(${gate},0))`;connection.release();}
 const outcomes=await Promise.all([...(first?[first]:[]),...(second?[second]:[])]);
 await owner.client.unsafe('drop trigger a_perf_payroll_pause on payslip; drop function public.perf_payroll_pause()');
 expect(reached).toBe(true);expect(outcomes).toEqual([{ok:true},{ok:true}]);
 const [persisted]=await owner.db.execute<{status:string;slips:number;requests:number}>(sql`select status,(select count(*)::int from payslip where batch_id=${batchId}::uuid) as slips,(select count(*)::int from leave_request where employment_id=${c.employmentId}::uuid) as requests from payroll_batch where id=${batchId}::uuid`);
 expect(persisted).toEqual({status:'processed',slips:1,requests:0});
 expect(overlap,'actual Home reader finishes before Payroll releases its pre-insert gate').toBe(true);
});
