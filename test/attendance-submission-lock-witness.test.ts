/** Test-only Access lock substitution around the real Attendance submission command. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {AttendanceCorrectionPendingError,requestAttendanceCorrection} from '../core/attendance';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import {withAttendanceTenant} from '../core/module-gate';
import {endReportingLine,hireEmployee,setReportingLine} from '../core/org';
import {AttendanceLevelError} from '../lib/attendance-workflow-v3';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

const dialect=new PgDialect();
const lockStatement='select pg_advisory_xact_lock(hashtextextended($1,0))';

function observedCarrier(tx:Tx,tenantId:string,companyId:string,shared:boolean,afterEpoch?:()=>Promise<void>){
 let access=0,workflow=0;
 const carrier=new Proxy(tx,{get(target,key){
  if(key==='execute')return async(statement:Parameters<Tx['execute']>[0])=>{
   if(typeof statement==='string')return target.execute(statement);
   const query=dialect.sqlToQuery(statement.getSQL());
   const key=query.sql.replace(/\s+/g,' ').trim()===lockStatement&&query.params.length===1?query.params[0]:undefined;
   if(key==='access-configuration:'+tenantId){
    access++;
    if(shared)return target.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${key},0))`);
   }
   const result=await target.execute(statement);
   // The second prepare starts only after correction INSERT has frozen its epoch.
   if(key===tenantId+':attendance-workflow:'+companyId+':irregularity'&&++workflow===2)await afterEpoch?.();
   return result;
  };
  const value=Reflect.get(target,key,target);
  return typeof value==='function'?value.bind(target):value;
 }});
 return {carrier,counts:()=>({access,workflow})};
}

function barrier(){
 let resolve!:()=>void;
 const promise=new Promise<void>(done=>{resolve=done;});
 return {promise,resolve};
}
async function within<T>(promise:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>reject(new Error('Independent company submissions did not reach their native epoch locks')),5000);
 })]);}finally{clearTimeout(timer);}
}

it('allows independent ordinary submissions to overlap before audit while retaining native epoch and route guards',async()=>{
 await resetDb();
 const base=await seedBase();
 await setModule(base.tenantId,'attendance','active');
 const admin=await entitledCtx(base),today=todayInKualaLumpur();
 const prior=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 const [secondCompany]=await owner.db.insert(s.company).values({tenantId:base.tenantId,legalName:'Fictional second submission company'}).returning();
 const [secondDepartment]=await owner.db.insert(s.department).values({tenantId:base.tenantId,companyId:secondCompany.id,name:'Fictional second department'}).returning();
 async function fixture(companyId:string,departmentId:string){
  const hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},
   companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
  const worker=await hire('Fictional clock correction applicant'),manager=await hire('Fictional accountable reviewer');
  const ctx:SessionContext={...admin,userId:await createAppUser(base.tenantId,worker.personId,'employee'),
   personId:worker.personId,roles:['employee'],grants:[{role:'employee',companyId}]};
  await createAppUser(base.tenantId,manager.personId,'manager');
  const line=await setReportingLine(admin,{subordinateEmploymentId:worker.employmentId,managerEmploymentId:manager.employmentId,
   lineType:'administrative',validFrom:'2020-01-01'});
  await saveAttendanceWorkflow(admin,{companyId,applicationType:'irregularity',routingVersion:4,code:'CLOCK_FIX',
   name:'Fictional clock correction route',priority:100,active:true,criteria:{employeeIds:[worker.employmentId]},
   stages:[{name:'Review',mode:'sequential',sources:[{kind:'direct_manager',depth:1}],hrAlternative:false}],cc:[]});
  await setAttendanceWorkflowEnabled(admin,companyId,'irregularity',true);
  const input={employmentId:worker.employmentId,date:today,checkIn:'09:00',checkOut:'18:00',reason:'Fictional ordinary request'};
  await requestAttendanceCorrection(ctx,{...input,date:prior});
  return {companyId,ctx,input,manager,reportingLineId:line.reportingLineId};
 }
 const first=await fixture(base.companyId,base.deptA),second=await fixture(secondCompany.id,secondDepartment.id);
 const rollback=new Error('rollback only');
 async function submit(subject:typeof first,shared:boolean,afterEpoch?:(pid:number)=>Promise<void>){
  let snapshot:unknown;
  await withAttendanceTenant(subject.ctx,async tx=>{
   await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);
   const [backend]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);
   const {carrier,counts}=observedCarrier(tx,base.tenantId,subject.companyId,shared,afterEpoch?()=>afterEpoch(backend.pid):undefined);
   const {correctionId}=await requestAttendanceCorrection(subject.ctx,subject.input,carrier);
   expect(counts()).toEqual({access:1,workflow:2});
   const expectedLocks=[
    ['access-configuration:'+base.tenantId,shared?'ShareLock':'ExclusiveLock'],
    ['leave-dependency-configuration:'+base.tenantId,'ShareLock'],
    ['leave-dependency-employment:'+base.tenantId+':'+subject.input.employmentId,'ExclusiveLock'],
    [base.tenantId+':'+subject.input.employmentId,'ExclusiveLock'],
    [base.tenantId+':attendance-workflow:'+subject.companyId+':irregularity','ExclusiveLock'],
   ];
   for(const [key,mode]of expectedLocks){
    const held=await tx.execute<{mode:string}>(sql`with k as(select hashtextextended(${key},0)as value)
     select l.mode from pg_locks l cross join k where l.pid=pg_backend_pid() and l.granted
      and l.locktype='advisory' and l.objsubid=1 and l.classid::bigint=((k.value>>32)&4294967295)
      and l.objid::bigint=(k.value&4294967295)`);
    expect(held).toEqual([{mode}]);
   }
   const audit=await tx.execute<{mode:string}>(sql`with k as(select hashtext(${'audit-chain:'+base.tenantId})::bigint as value)
    select l.mode from pg_locks l cross join k where l.pid=pg_backend_pid() and l.granted
     and l.locktype='advisory' and l.objsubid=1 and l.classid::bigint=((k.value>>32)&4294967295)
     and l.objid::bigint=(k.value&4294967295)`);
   expect(audit).toEqual([{mode:'ExclusiveLock'}]);
   const [contract]=await tx.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,correctionId));
   expect(contract).toMatchObject({companyId:subject.companyId,kind:'epoch',visibleEpoch:expect.any(Number),
    plannedWindow:null,attestedWork:null,policyBinding:null});
   const [flow]=await tx.select().from(s.attendanceWorkflowRequest).where(eq(s.attendanceWorkflowRequest.correctionId,correctionId));
   expect(flow).toMatchObject({routingVersion:4,companyId:subject.companyId,currentStage:0,cc:[]});
   expect(flow.stages[0].approvers[0]).toMatchObject({employmentId:subject.manager.employmentId,slot:'0:0'});
   const [row]=await tx.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,correctionId));
   expect(row).toMatchObject({status:'pending',requestedOtMinutes:null,approvedOtMinutes:null,requestKind:'other'});
   const events=await tx.select({type:s.domainEvent.eventType,actor:s.domainEvent.actorId,
    sequence:s.domainEvent.chainSeq,hash:s.domainEvent.hash,previous:s.domainEvent.prevHash}).from(s.domainEvent)
    .where(eq(s.domainEvent.aggregateId,correctionId)).orderBy(asc(s.domainEvent.chainSeq));
   expect(events.map(event=>[event.type,event.actor])).toEqual([
    ['attendance-workflow.resolved',subject.ctx.userId],['attendance-correction.requested',subject.ctx.userId],
   ]);
   expect(events[1].previous).toBe(events[0].hash);
   expect(events[1].sequence).toBe(events[0].sequence!+1);
   snapshot={epoch:contract.visibleEpoch,method:contract.manualApprovalMethod,stages:flow.stages,cc:flow.cc,
    type:row.requestKind,clockIn:row.proposedCheckIn,clockOut:row.proposedCheckOut,reason:row.reason,events:events.map(({type,actor})=>({type,actor}))};
   throw rollback;
  }).catch(error=>{if(error!==rollback)throw error;});
  return snapshot;
 }
 expect(await submit(first,true)).toEqual(await submit(first,false));
 await expect(requestAttendanceCorrection(first.ctx,{...first.input,date:prior})).rejects.toBeInstanceOf(AttendanceCorrectionPendingError);
 await expect(requestAttendanceCorrection(first.ctx,second.input)).rejects.toThrow('Attendance subject is unavailable.');

 await owner.client`alter table domain_event add constraint attendance_submission_witness_late_failure
  check (event_type <> 'attendance-correction.requested') not valid`;
 try{
  await expect(submit(first,true)).rejects.toMatchObject({cause:{constraint_name:'attendance_submission_witness_late_failure'}});
 }finally{
  await owner.client`alter table domain_event drop constraint attendance_submission_witness_late_failure`;
 }

 const entered=[barrier(),barrier()],release=barrier();
 const pids:number[]=[];
 const inflight=[first,second].map((subject,index)=>submit(subject,true,async pid=>{
  pids[index]=pid;entered[index].resolve();await release.promise;
 }));
 let revoke:Promise<unknown>|undefined;
 try{
  await within(Promise.race([Promise.all(entered.map(point=>point.promise)),
   Promise.all(inflight).then(()=>{throw new Error('Submissions completed before observing their locks');})]));
  for(const subject of [first,second]){
   await expect(owner.client.begin(tx=>tx`select epoch from app.attendance_policy_company_epoch
    where tenant_id=${base.tenantId}::uuid and company_id=${subject.companyId}::uuid for update nowait`))
    .rejects.toMatchObject({code:'55P03'});
  }
  revoke=endReportingLine(admin,{reportingLineId:first.reportingLineId,endDate:prior});
  await within((async()=>{
   for(let attempt=0;attempt<100;attempt++){
    const [row]=await owner.client`select exists(select 1 from pg_locks l where l.locktype='advisory' and not l.granted
      and l.mode='ExclusiveLock' and ${pids[0]}::integer=any(pg_blocking_pids(l.pid))) as waiting`;
    if(row.waiting)return;
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   throw new Error('Native reporting-line writer did not wait behind the submission');
  })());
 }finally{
  release.resolve();
  await Promise.all([...inflight,...(revoke?[revoke]:[])]);
 }
 await expect(submit(first,true)).rejects.toBeInstanceOf(AttendanceLevelError);
 await expect(submit(first,false)).rejects.toBeInstanceOf(AttendanceLevelError);
 const [retained]=await owner.db.select({count:sql<number>`count(*)::int`}).from(s.attendanceCorrection)
  .where(and(eq(s.attendanceCorrection.tenantId,base.tenantId),eq(s.attendanceCorrection.attendanceDate,today)));
 expect(retained.count).toBe(0);
 expect(await owner.db.select({id:s.attendance.id}).from(s.attendance).where(eq(s.attendance.tenantId,base.tenantId))).toEqual([]);
 expect(await owner.db.select({id:s.attendancePunch.id}).from(s.attendancePunch).where(eq(s.attendancePunch.tenantId,base.tenantId))).toEqual([]);
 expect(await owner.db.select({id:s.attendanceOvertimeSource.id}).from(s.attendanceOvertimeSource)
  .where(eq(s.attendanceOvertimeSource.tenantId,base.tenantId))).toEqual([]);
 expect(await owner.db.select({id:s.payrollInput.id}).from(s.payrollInput).where(eq(s.payrollInput.tenantId,base.tenantId))).toEqual([]);
 const contracts=await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.tenantId,base.tenantId));
 expect(contracts).toHaveLength(2);
 expect(contracts.every(contract=>contract.attendanceDate===prior)).toBe(true);
 const flows=await owner.db.select().from(s.attendanceWorkflowRequest).where(eq(s.attendanceWorkflowRequest.tenantId,base.tenantId));
 expect(flows).toHaveLength(2);
 const requests=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,base.tenantId),
  eq(s.domainEvent.eventType,'attendance-correction.requested')));
 expect(requests).toHaveLength(2);
},30000);
