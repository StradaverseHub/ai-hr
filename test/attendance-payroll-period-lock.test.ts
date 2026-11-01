/** Real native batch exclusion: retain relevant drafts without locking unrelated months. */
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withDataCommand} from '../core/data-command';
import {lockPayrollForAttendanceChange} from '../core/payroll-closed-runs';
import {hireEmployee} from '../core/org';
import * as s from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(async()=>{
 await migrateTestDb();
 const rows=await owner.client`select p.oid::regprocedure::text as identity,p.prosrc,pg_get_functiondef(p.oid) as definition,to_jsonb(p) as attributes from pg_proc p where p.oid in ('app.attendance_payroll_protection(uuid)'::regprocedure,'app.attendance_payroll_protection_rows(uuid)'::regprocedure)`;
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'attendance-payroll-native-donors.json'),JSON.stringify(rows.map(row=>({...row,bodySha256:createHash('sha256').update(row.prosrc).digest('hex')})),null,2));
});
it('physically locks current and next-month drafts but leaves an unrelated older draft free',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),today=todayInKualaLumpur();
 const subject=await hireEmployee(ctx,{person:{fullName:'Fictional draft lock subject',primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const shifted=(delta:number)=>{const date=new Date(today+'T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+delta,15);return date.toISOString().slice(0,7);};
 const batches=[];
 for(const delta of [-6,0,1]){
  const month=shifted(delta),[period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:month}).returning();
  const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:month,batchDate:month+'-15'}).returning();batches.push(batch);
 }
 await withDataCommand(ctx,async tx=>{
  expect(await lockPayrollForAttendanceChange(tx,subject.employmentId,today)).toEqual([]);
  const blocked=[];
  for(const batch of batches){
   try{await owner.client.begin(async connection=>{await connection`select id from payroll_batch where id=${batch.id}::uuid for update nowait`;});blocked.push(false);}
   catch(error){expect((error as {code:string}).code).toBe('55P03');blocked.push(true);}
  }
  expect(blocked,'drafts are locked before any payslip exists; obsolete months do not serialize Attendance').toEqual([false,true,true]);
 });
});
afterAll(closeAll);
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
it.each([false,true])('keeps same-period exclusion while unrelated Attendance commands overlap (same period: %s)',async samePeriod=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),today=todayInKualaLumpur();
 const oldDate=new Date(today+'T12:00:00Z');oldDate.setUTCMonth(oldDate.getUTCMonth()-6,15);const oldMonth=oldDate.toISOString().slice(0,7);
 const employees=[];
 for(const name of ['A','B'])employees.push(await hireEmployee(ctx,{person:{fullName:'Fictional period subject '+name,primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}));
 const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:oldMonth}).returning();
 await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:oldMonth,batchDate:oldMonth+'-15'});
 const entered=barrier(),release=barrier();
 const first=withDataCommand(ctx,async tx=>{const rows=await lockPayrollForAttendanceChange(tx,employees[0].employmentId,oldMonth+'-15');entered.resolve();await release.promise;return rows;});
 const settledFirst=first.then(value=>({ok:true,value}),error=>({ok:false,error}));
 let second:Promise<unknown>|undefined,overlap=false;
 try{
  const reached=await Promise.race([entered.promise.then(()=>true),settledFirst.then(()=>false),delay(2000).then(()=>false)]);
  expect(reached,'first real guard owns its draft batch before the second command').toBe(true);
  second=withDataCommand(ctx,tx=>lockPayrollForAttendanceChange(tx,employees[1].employmentId,samePeriod?oldMonth+'-16':today));
  const outcome=second.then(value=>({ok:true,value}),error=>({ok:false,error}));
  overlap=await Promise.race([outcome.then(result=>result.ok),delay(200).then(()=>false)]);
  release.resolve();expect(await settledFirst).toEqual({ok:true,value:[]});expect(await outcome).toEqual({ok:true,value:[]});
 }finally{release.resolve();await Promise.allSettled([first,...(second?[second]:[])]);}
 expect(overlap,'only the unrelated month completes while the first guard owns its draft').toBe(!samePeriod);
});
