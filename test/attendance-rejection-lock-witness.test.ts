/** Test-only lock substitution around the actual decision command. All decision writes roll back. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import {attendance,attendanceCorrection,attendancePunch,attendanceWorkflowRequest,attendanceWorkflowDecision,attendanceWorkflowParticipantDecision,domainEvent} from '../db/schema';
import {decideAttendanceCorrection,MissingAttendanceRejectReasonError,requestAttendanceCorrection} from '../core/attendance';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import {withAttendanceTenant} from '../core/module-gate';
import {endReportingLine,hireEmployee,setReportingLine} from '../core/org';
import {LeaveDependencyUnavailable} from '../core/leave-dependency-lock';
import {lockAccessConfigurationWriteTx} from '../core/access-configuration-lock';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
import {restoreHistoricalAttendanceSubmission} from './helpers/attendance-submission-fixture';

beforeAll(migrateTestDb);
afterAll(closeAll);

const dialect=new PgDialect();
const attendanceSubjectStatement='select pg_advisory_xact_lock(hashtextextended($1, 0))';

/** Wave 4: a decision in a caller-owned transaction joins the Access lock itself (shared unless the caller
 * already holds a mode), so the carrier only observes the attendance subject lock; lock modes are read
 * back from pg_locks. An 'exclusive' caller takes the exclusive Access lock before deciding. */
function observedCarrier(tx:Tx,tenantId:string,employmentId:string,onSubjectLocked?:()=>Promise<void>){
  let subject=0;
  const carrier=new Proxy(tx,{get(target,key){
    if(key==='execute')return async (statement:Parameters<Tx['execute']>[0])=>{
      if(typeof statement==='string')return target.execute(statement);
      const compiled=dialect.sqlToQuery(statement.getSQL());
      const text=compiled.sql.replace(/\s+/g,' ').trim();
      const params=compiled.params;
      const result=await target.execute(statement);
      if(text===attendanceSubjectStatement&&params.length===1&&params[0]===tenantId+':'+employmentId){
        subject++;
        if(onSubjectLocked)await onSubjectLocked();
      }
      return result;
    };
    const value=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }});
  return {carrier,subjectLocks:()=>subject};
}
type CallerMode='shared'|'exclusive';
const accessModes=(mode:CallerMode)=>[mode==='shared'?'ShareLock':'ExclusiveLock'];
const leaveConfigurationModes=(mode:CallerMode)=>mode==='shared'?['ShareLock']:['ExclusiveLock','ShareLock'];

async function lockModes(tx:Tx,tenantId:string,employmentId:string){
  return tx.execute<{key:string;mode:string}>(sql`
    with keys(key,value) as (values
      ('access',hashtextextended(${'access-configuration:'+tenantId},0)),
      ('leaveConfiguration',hashtextextended(${'leave-dependency-configuration:'+tenantId},0)),
      ('leaveSubject',hashtextextended(${'leave-dependency-employment:'+tenantId+':'+employmentId},0)),
      ('attendanceSubject',hashtextextended(${tenantId+':'+employmentId},0)),
      ('audit',hashtext(${'audit-chain:'+tenantId})::bigint))
    select k.key,l.mode from keys k join pg_locks l
      on l.classid::bigint=((k.value>>32)&4294967295) and l.objid::bigint=(k.value&4294967295)
    where l.pid=pg_backend_pid() and l.locktype='advisory' and l.objsubid=1 and l.granted
    order by k.key,l.mode
  `);
}

function barrier(){
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}

async function within<T>(promise:Promise<T>,ms=5000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([promise,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Independent rejection subjects did not overlap')),ms);
    })]);
  }finally{clearTimeout(timer);}
}

it('proves legacy non-OT rejection native writes and audit require no configuration lock upgrade',async()=>{
  await resetDb();
  const base=await seedBase();
  const admin=adminCtx(base);
  await setModule(base.tenantId,'attendance','active');
  const restoreRequest=async(name:string,requestedOtMinutes:number|null=null)=>{
    const subject=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},
      companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
    // Keep the original clock-pair shape and restore the pending row that predates mandatory routing.
    const {id}=await restoreHistoricalAttendanceSubmission(base,{
      employmentId:subject.employmentId,attendanceDate:todayInKualaLumpur(),status:'pending',requestKind:'other',
      proposedCheckIn:'09:00',proposedCheckOut:'18:00',requestedOtMinutes,reason:'Fictional legacy request',
      originalClockSnapshot:{version:1,attendanceId:null,originalCheckIn:null,originalCheckOut:null,capturedAt:new Date().toISOString()},
    });
    return {correctionId:id,employmentId:subject.employmentId};
  };
  const first=await restoreRequest('Fictional rejection subject A');
  const second=await restoreRequest('Fictional rejection subject B');
  expect(await owner.db.select({id:attendanceWorkflowRequest.id}).from(attendanceWorkflowRequest)
    .where(eq(attendanceWorkflowRequest.tenantId,base.tenantId))).toEqual([]);
  const rollback=new Error('rollback only');
  async function reject(request:typeof first,mode:CallerMode,onSubjectLocked?:()=>Promise<void>){
    let snapshot:unknown;
    await withAttendanceTenant(admin,async tx=>{
      await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);
      if(mode==='exclusive')await lockAccessConfigurationWriteTx(tx,base.tenantId);
      const {carrier,subjectLocks}=observedCarrier(tx,base.tenantId,request.employmentId,onSubjectLocked);
      const result=await decideAttendanceCorrection(admin,{correctionId:request.correctionId,decision:'rejected',
        rejectReason:'Fictional native rejection witness'},carrier);
      expect(result).toEqual({status:'rejected',deferred:false});
      expect(subjectLocks()).toBe(1);
      const modes=await lockModes(tx,base.tenantId,request.employmentId);
      expect(modes.filter(row=>row.key==='access').map(row=>row.mode)).toEqual(accessModes(mode));
      expect(modes.filter(row=>row.key==='leaveConfiguration').map(row=>row.mode)).toEqual(leaveConfigurationModes(mode));
      for(const key of ['leaveSubject','attendanceSubject','audit']){
        expect(modes.filter(row=>row.key===key)).toEqual([{key,mode:'ExclusiveLock'}]);
      }
      const [row]=await tx.select().from(attendanceCorrection).where(eq(attendanceCorrection.id,request.correctionId));
      expect(row).toMatchObject({status:'rejected',requestedOtMinutes:null,rejectReason:'Fictional native rejection witness'});
      const events=await tx.select({type:domainEvent.eventType,payload:domainEvent.payload,seq:domainEvent.chainSeq,
        hash:domainEvent.hash,prevHash:domainEvent.prevHash}).from(domainEvent)
        .where(and(eq(domainEvent.aggregateId,request.correctionId),eq(domainEvent.eventType,'attendance-correction.rejected')))
        .orderBy(asc(domainEvent.chainSeq));
      expect(events).toHaveLength(1);
      expect(events[0].hash).toMatch(/^[a-f0-9]{64}$/);
      expect(await tx.select({id:attendance.id}).from(attendance).where(eq(attendance.employmentId,request.employmentId))).toEqual([]);
      expect(await tx.select({id:attendancePunch.id}).from(attendancePunch).where(eq(attendancePunch.employmentId,request.employmentId))).toEqual([]);
      const {decidedAt,...stableRow}=row;
      expect(decidedAt).toBeInstanceOf(Date);
      snapshot={result,stableRow,events};
      throw rollback;
    }).catch(error=>{if(error!==rollback)throw error;});
    return snapshot;
  }
  expect(await reject(first,'shared')).toEqual(await reject(first,'exclusive'));

  const entered=[barrier(),barrier()],release=barrier();
  const concurrent=[first,second].map((request,index)=>reject(request,'shared',async()=>{
    entered[index].resolve();
    await release.promise;
  }));
  try{
    await within(Promise.race([Promise.all(entered.map(point=>point.promise)),...concurrent]));
    for(const key of ['access-configuration:','leave-dependency-configuration:']){
      const obtained=await owner.client.begin(async tx=>{
        const [row]=await tx`select pg_try_advisory_xact_lock(hashtextextended(${key+base.tenantId},0)) as obtained`;
        return row.obtained;
      });
      expect(obtained).toBe(false);
    }
    // A same-subject decision waits, with the bound, for the employment lock and then refuses as busy.
    await within(withAttendanceTenant(admin,async tx=>{
      await expect(decideAttendanceCorrection(admin,{correctionId:first.correctionId,decision:'rejected',
        rejectReason:'Conflicting fictional same-subject rejection'},tx)).rejects.toBeInstanceOf(LeaveDependencyUnavailable);
      throw rollback;
    }).catch(error=>{if(error!==rollback)throw error;}),12000);
  }finally{
    release.resolve();
    await Promise.all(concurrent);
  }
  const retained=await owner.db.select({id:attendanceCorrection.id,status:attendanceCorrection.status}).from(attendanceCorrection)
    .where(eq(attendanceCorrection.tenantId,base.tenantId));
  expect(retained).toHaveLength(2);
  expect(retained.every(row=>row.status==='pending')).toBe(true);
  expect(await owner.db.select({id:domainEvent.id}).from(domainEvent)
    .where(and(eq(domainEvent.tenantId,base.tenantId),eq(domainEvent.eventType,'attendance-correction.rejected')))).toEqual([]);
  await expect(decideAttendanceCorrection(admin,{correctionId:first.correctionId,decision:'rejected'}))
    .rejects.toBeInstanceOf(MissingAttendanceRejectReasonError);
  const rowsLocked=barrier(),unlockRows=barrier();
  let rowLockerPid=0;
  const rowLocker=owner.client.begin(async tx=>{
    const [connection]=await tx`select pg_backend_pid() as pid`;
    rowLockerPid=connection.pid;
    await tx`select id from attendance_correction where id in (${first.correctionId}::uuid,${second.correctionId}::uuid)
      order by id for update`;
    rowsLocked.resolve();
    await unlockRows.promise;
  });
  const decisions:Promise<unknown>[]=[];
  let duplicate:Promise<unknown>|undefined;
  try{
    await within(Promise.race([rowsLocked.promise,rowLocker]));
    for(const request of [first,second]){
      decisions.push(decideAttendanceCorrection(admin,{correctionId:request.correctionId,decision:'rejected',
        rejectReason:'Fictional direct concurrent rejection'}));
    }
    const decisionsFinishedBeforeLockWitness=Promise.all(decisions).then(()=>{
      throw new Error('Rejections completed before their held shared Access locks could be observed');
    });
    await within(Promise.race([decisionsFinishedBeforeLockWitness, (async()=>{
      for(let attempt=0;attempt<100;attempt++){
        const [result]=await owner.client`with key as (select hashtextextended(${'access-configuration:'+base.tenantId},0) as value)
          select count(distinct l.pid)::integer as readers from pg_locks l cross join key k
          where l.locktype='advisory' and l.mode='ShareLock' and l.granted and l.objsubid=1
            and l.classid::bigint=((k.value>>32)&4294967295) and l.objid::bigint=(k.value&4294967295)
            and ${rowLockerPid}::integer=any(pg_blocking_pids(l.pid))`;
        if(result.readers===2)return;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw new Error('Both public rejection commands must reach their correction-row wait holding shared Access');
    })()]));
    duplicate=decideAttendanceCorrection(admin,{correctionId:first.correctionId,decision:'rejected',
      rejectReason:'Fictional duplicate rejection'}).then(
      () => { throw new Error('Duplicate rejection unexpectedly succeeded'); },
      error => error,
    );
    const duplicateFinishedBeforeLockWitness=duplicate.then(error=>{throw error;});
    // The duplicate's ordinary attempt rolls back on the busy subject, then retries on the held course: it waits
    // for the employment lock while holding only the shared Access lock, never the exclusive one.
    await within(Promise.race([duplicateFinishedBeforeLockWitness,(async()=>{
      for(let attempt=0;attempt<100;attempt++){
        const [result]=await owner.client`with access as (select hashtextextended(${'access-configuration:'+base.tenantId},0) as value),
          subject as (select hashtextextended(${'leave-dependency-employment:'+base.tenantId+':'+first.employmentId},0) as value)
          select exists(select 1 from pg_locks l cross join subject k
            where l.locktype='advisory' and l.mode='ExclusiveLock' and not l.granted and l.objsubid=1
              and l.classid::bigint=((k.value>>32)&4294967295) and l.objid::bigint=(k.value&4294967295)
              and exists(select 1 from pg_locks s cross join access a where s.pid=l.pid and s.locktype='advisory'
                and s.mode='ShareLock' and s.granted and s.objsubid=1
                and s.classid::bigint=((a.value>>32)&4294967295) and s.objid::bigint=(a.value&4294967295))
              and not exists(select 1 from pg_locks x cross join access a where x.pid=l.pid and x.locktype='advisory'
                and x.mode='ExclusiveLock' and x.objsubid=1
                and x.classid::bigint=((a.value>>32)&4294967295) and x.objid::bigint=(a.value&4294967295))) as waiting`;
        if(result.waiting)return;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw new Error('Same-subject rejection must wait for the employment lock holding only shared Access');
    })()]));
  }finally{
    unlockRows.resolve();
    await rowLocker;
    await Promise.all([...decisions,duplicate]);
  }
  expect(await duplicate).toMatchObject({message:'correction request is already rejected'});
  expect(await Promise.all(decisions)).toEqual([
    {status:'rejected',deferred:false},{status:'rejected',deferred:false},
  ]);
  expect(await owner.db.select({id:domainEvent.id}).from(domainEvent)
    .where(and(eq(domainEvent.tenantId,base.tenantId),eq(domainEvent.eventType,'attendance-correction.rejected')))).toHaveLength(2);

  const overtime=await restoreRequest('Fictional overtime rejection subject',60);
  const holdingAccess=barrier(),releaseAccess=barrier();
  let accessHolderPid=0;
  const accessHolder=owner.client.begin(async tx=>{
    const [connection]=await tx`select pg_backend_pid() as pid`;
    accessHolderPid=connection.pid;
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+base.tenantId},0))`;
    holdingAccess.resolve();
    await releaseAccess.promise;
  });
  let overtimeDecision:ReturnType<typeof decideAttendanceCorrection>|undefined;
  try{
    await within(Promise.race([holdingAccess.promise,accessHolder]));
    // Wave 4: an overtime-bearing rejection takes the approval's held course, which shares the Access lock, so it
    // completes while another writer holds the shared lock instead of waiting for exclusive Access.
    overtimeDecision=decideAttendanceCorrection(admin,{correctionId:overtime.correctionId,decision:'rejected',
      rejectReason:'Fictional overtime rejection shares configuration'});
    expect(accessHolderPid).toBeGreaterThan(0);
    expect(await within(overtimeDecision,15000)).toEqual({status:'rejected',deferred:false});
  }finally{
    releaseAccess.resolve();
    await accessHolder;
    await overtimeDecision;
  }
  expect(await overtimeDecision).toEqual({status:'rejected',deferred:false});
},30000);

it.each([1,2,3,4,'delegated-v2'] as const)('keeps versioned non-OT rejection and audit under shared configuration: %s',async route=>{
  await resetDb();
  const base=await seedBase(),admin=adminCtx(base),today=todayInKualaLumpur();
  await setModule(base.tenantId,'attendance','active');
  async function person(name:string,role:'manager'|'employee'){
    const hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},
      companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
    const ctx:SessionContext={...admin,userId:await createAppUser(base.tenantId,hired.personId,role),
      personId:hired.personId,roles:[role],grants:[{role,companyId:base.companyId}]};
    return {...hired,ctx};
  }
  const worker=await person('Fictional workflow applicant','employee');
  const manager=await person('Fictional assigned manager','manager');
  await setReportingLine(admin,{subordinateEmploymentId:worker.employmentId,managerEmploymentId:manager.employmentId,
    lineType:'administrative',validFrom:'2020-01-01'});
  let reviewer=manager,delegationId:string|undefined;
  if(route==='delegated-v2'){
    reviewer=await person('Fictional live delegate','manager');
    const downline=await person('Fictional delegate downline','employee');
    await setReportingLine(admin,{subordinateEmploymentId:downline.employmentId,managerEmploymentId:reviewer.employmentId,
      lineType:'administrative',validFrom:'2020-01-01'});
    const delegation=await setReportingLine(admin,{subordinateEmploymentId:manager.employmentId,
      managerEmploymentId:reviewer.employmentId,lineType:'delegate',validFrom:'2020-01-01',
      scopes:[{module:'attendance',taskType:'attendance.correction'}]});
    delegationId=delegation.reportingLineId;
  }
  const common={companyId:base.companyId,code:'REJECT_WITNESS',name:'Fictional rejection workflow',
    applicationType:'irregularity' as const,priority:100,active:true,criteria:{employeeIds:[worker.employmentId]}};
  const participant={kind:'specific_employee' as const,employmentIds:[manager.employmentId]};
  if(route===3){
    await saveAttendanceWorkflow(admin,{...common,routingVersion:3,
      stages:[{name:'Review',mode:'sequential',source:participant,hrAlternative:false}]});
  }else if(route===4){
    await saveAttendanceWorkflow(admin,{...common,routingVersion:4,cc:[],
      stages:[{name:'Review',mode:'sequential',sources:[participant],hrAlternative:false}]});
  }else{
    await saveAttendanceWorkflow(admin,{...common,routingVersion:route===1?1:2,
      stages:[{name:'Review',level:{kind:'direct_manager',employmentId:null,alternates:[]}}]});
  }
  await setAttendanceWorkflowEnabled(admin,base.companyId,'irregularity',true);
  const {correctionId}=await requestAttendanceCorrection(worker.ctx,{employmentId:worker.employmentId,date:today,
    checkIn:'09:00',checkOut:'18:00',reason:'Fictional versioned non-overtime request'});
  const input={correctionId,decision:'rejected' as const,rejectReason:'Fictional native rejection witness',
    expectedStageIndex:0,...(route===3||route===4?{expectedParticipantSlot:'0:0'}:{})};
  const rollback=new Error('rollback only');
  async function reject(mode:CallerMode,onSubjectLocked?:(pid:number)=>Promise<void>){
    let snapshot:unknown;
    await withAttendanceTenant(reviewer.ctx,async tx=>{
      await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);
      if(mode==='exclusive')await lockAccessConfigurationWriteTx(tx,base.tenantId);
      const [connection]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);
      const {carrier,subjectLocks}=observedCarrier(tx,base.tenantId,worker.employmentId,
        onSubjectLocked?()=>onSubjectLocked(connection.pid):undefined);
      expect(await decideAttendanceCorrection(reviewer.ctx,input,carrier)).toEqual({status:'rejected',deferred:false});
      expect(subjectLocks()).toBe(1);
      const modes=await lockModes(tx,base.tenantId,worker.employmentId);
      expect(modes.filter(row=>row.key==='access').map(row=>row.mode)).toEqual(accessModes(mode));
      expect(modes.filter(row=>row.key==='leaveConfiguration').map(row=>row.mode)).toEqual(leaveConfigurationModes(mode));
      expect(modes.filter(row=>row.key==='audit')).toEqual([{key:'audit',mode:'ExclusiveLock'}]);
      const [row]=await tx.select({status:attendanceCorrection.status,reason:attendanceCorrection.rejectReason})
        .from(attendanceCorrection).where(eq(attendanceCorrection.id,correctionId));
      expect(row).toEqual({status:'rejected',reason:input.rejectReason});
      const [flow]=await tx.select().from(attendanceWorkflowRequest).where(eq(attendanceWorkflowRequest.correctionId,correctionId));
      expect(flow).toMatchObject({routingVersion:typeof route==='number'?route:2,currentStage:1});
      const decisions=await tx.select({actualUserId:attendanceWorkflowDecision.actualUserId,
        actingMode:attendanceWorkflowDecision.actingMode,decision:attendanceWorkflowDecision.decision})
        .from(attendanceWorkflowDecision).where(eq(attendanceWorkflowDecision.requestId,flow.id));
      expect(decisions).toEqual([{actualUserId:reviewer.ctx.userId,actingMode:delegationId?'delegate':'assigned',decision:'rejected'}]);
      const participants=await tx.select({decision:attendanceWorkflowParticipantDecision.decision,
        slot:attendanceWorkflowParticipantDecision.participantSlot}).from(attendanceWorkflowParticipantDecision)
        .where(eq(attendanceWorkflowParticipantDecision.requestId,flow.id));
      expect(participants).toEqual(route===3||route===4?[{decision:'rejected',slot:'0:0'}]:[]);
      const events=await tx.select({type:domainEvent.eventType,actor:domainEvent.actorId,hash:domainEvent.hash,
        prevHash:domainEvent.prevHash,sequence:domainEvent.chainSeq}).from(domainEvent)
        .where(and(eq(domainEvent.aggregateId,correctionId),eq(domainEvent.actorId,reviewer.ctx.userId!)))
        .orderBy(asc(domainEvent.chainSeq));
      expect(events.map(event=>event.type)).toEqual(['attendance-workflow.stage.decided','attendance-correction.rejected']);
      expect(events[0].hash).toMatch(/^[a-f0-9]{64}$/);
      expect(events[1].hash).toMatch(/^[a-f0-9]{64}$/);
      expect(events[1].prevHash).toBe(events[0].hash);
      expect(events[1].sequence).toBe(events[0].sequence!+1);
      snapshot={row,stage:flow.currentStage,decisions,participants,events:events.map(({type,actor,sequence})=>({type,actor,sequence}))};
      throw rollback;
    }).catch(error=>{if(error!==rollback)throw error;});
    return snapshot;
  }
  expect(await reject('shared')).toEqual(await reject('exclusive'));
  if(route===4){
    await owner.client`alter table domain_event add constraint attendance_rejection_witness_late_failure
      check (event_type <> 'attendance-correction.rejected') not valid`;
    try{
      await expect(decideAttendanceCorrection(reviewer.ctx,input)).rejects.toMatchObject({
        cause:{constraint_name:'attendance_rejection_witness_late_failure'},
      });
      const [flow]=await owner.db.select().from(attendanceWorkflowRequest).where(eq(attendanceWorkflowRequest.correctionId,correctionId));
      expect(flow.currentStage).toBe(0);
      expect(await owner.db.select().from(attendanceWorkflowDecision).where(eq(attendanceWorkflowDecision.requestId,flow.id))).toEqual([]);
      expect(await owner.db.select().from(attendanceWorkflowParticipantDecision).where(eq(attendanceWorkflowParticipantDecision.requestId,flow.id))).toEqual([]);
      expect(await owner.db.select({id:domainEvent.id}).from(domainEvent).where(and(eq(domainEvent.aggregateId,correctionId),
        eq(domainEvent.eventType,'attendance-workflow.stage.decided')))).toEqual([]);
    }finally{
      await owner.client`alter table domain_event drop constraint attendance_rejection_witness_late_failure`;
    }
  }
  if(delegationId){
    const entered=barrier(),release=barrier();
    let pid=0;
    const pending=reject('shared',async connectionPid=>{pid=connectionPid;entered.resolve();await release.promise;});
    let revocation:Promise<unknown>|undefined;
    try{
      await within(Promise.race([entered.promise,pending]));
      revocation=endReportingLine(admin,{reportingLineId:delegationId,endDate:new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10)});
      await within((async()=>{
        for(let attempt=0;attempt<100;attempt++){
          const [lock]=await owner.client`select exists(select 1 from pg_locks l
            where l.locktype='advisory' and l.mode='ExclusiveLock' and not l.granted
              and ${pid}::integer=any(pg_blocking_pids(l.pid))) as waiting`;
          if(lock.waiting)return;
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw new Error('Live delegation revocation did not wait behind the shared configuration lock');
      })());
    }finally{
      release.resolve();
      await Promise.all([pending,...(revocation?[revocation]:[])]);
    }
    await expect(withAttendanceTenant(reviewer.ctx,tx=>decideAttendanceCorrection(reviewer.ctx,input,tx))).rejects.toThrow();
    await expect(decideAttendanceCorrection(reviewer.ctx,input)).rejects.toThrow();
  }
  const [retained]=await owner.db.select().from(attendanceCorrection).where(eq(attendanceCorrection.id,correctionId));
  expect(retained.status).toBe('pending');
  expect(await owner.db.select({id:attendance.id}).from(attendance).where(eq(attendance.employmentId,worker.employmentId))).toEqual([]);
  expect(await owner.db.select({id:attendancePunch.id}).from(attendancePunch).where(eq(attendancePunch.employmentId,worker.employmentId))).toEqual([]);
  expect(await owner.db.select({id:domainEvent.id}).from(domainEvent)
    .where(and(eq(domainEvent.aggregateId,correctionId),eq(domainEvent.eventType,'attendance-correction.rejected')))).toEqual([]);
},30000);
