/** Test-only lock substitution around the actual decision command. All decision writes roll back. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import {attendance,attendanceCorrection,attendancePunch,domainEvent} from '../db/schema';
import {decideAttendanceCorrection,requestAttendanceCorrection} from '../core/attendance';
import {withAttendanceTenant} from '../core/module-gate';
import {hireEmployee} from '../core/org';
import {LeaveDependencyUnavailable} from '../core/leave-dependency-lock';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

const dialect=new PgDialect();
const accessStatement='select pg_advisory_xact_lock(hashtextextended($1,0))';
const attendanceSubjectStatement='select pg_advisory_xact_lock(hashtextextended($1, 0))';
const leaveStatement="select case when app.current_tenant_id()=$1::uuid and current_setting('transaction_isolation')='read committed' and current_setting('transaction_read_only')='off' then pg_try_advisory_xact_lock(hashtextextended($2,0)) else false end as acquired";

function observedCarrier(tx:Tx,tenantId:string,employmentId:string,shared:boolean,onSubjectLocked?:()=>Promise<void>){
  let access=0,leave=0,subject=0;
  const carrier=new Proxy(tx,{get(target,key){
    if(key==='execute')return async (statement:Parameters<Tx['execute']>[0])=>{
      if(typeof statement==='string')return target.execute(statement);
      const compiled=dialect.sqlToQuery(statement.getSQL());
      const text=compiled.sql.replace(/\s+/g,' ').trim();
      const params=compiled.params;
      if(text===accessStatement&&params.length===1&&params[0]==='access-configuration:'+tenantId){
        access++;
        if(shared)return target.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${params[0]},0))`);
      }
      if(text===leaveStatement&&params.length===2&&params[0]===tenantId&&params[1]==='leave-dependency-configuration:'+tenantId){
        leave++;
        if(shared)return target.execute(sql`select case
          when app.current_tenant_id()=${params[0]}::uuid and current_setting('transaction_isolation')='read committed'
            and current_setting('transaction_read_only')='off'
          then pg_try_advisory_xact_lock_shared(hashtextextended(${params[1]},0))
          else false end as acquired`);
      }
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
  return {carrier,counts:()=>({access,leave,subject})};
}

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

async function within<T>(promise:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([promise,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Independent rejection subjects did not overlap')),5000);
    })]);
  }finally{clearTimeout(timer);}
}

it('proves legacy non-OT rejection native writes and audit require no configuration lock upgrade',async()=>{
  await resetDb();
  const base=await seedBase();
  const admin=adminCtx(base);
  await setModule(base.tenantId,'attendance','active');
  const makeRequest=async(name:string)=>{
    const subject=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},
      companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
    const employee:SessionContext={...admin,userId:await createAppUser(base.tenantId,subject.personId,'employee'),
      personId:subject.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}]};
    const {correctionId}=await requestAttendanceCorrection(employee,{employmentId:subject.employmentId,date:todayInKualaLumpur(),
      checkIn:'09:00',checkOut:'18:00',reason:'Fictional legacy non-overtime request'});
    return {correctionId,employmentId:subject.employmentId};
  };
  const first=await makeRequest('Fictional rejection subject A');
  const second=await makeRequest('Fictional rejection subject B');
  const rollback=new Error('rollback only');
  async function reject(request:typeof first,shared:boolean,onSubjectLocked?:()=>Promise<void>){
    let snapshot:unknown;
    await withAttendanceTenant(admin,async tx=>{
      await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);
      const {carrier,counts}=observedCarrier(tx,base.tenantId,request.employmentId,shared,onSubjectLocked);
      const result=await decideAttendanceCorrection(admin,{correctionId:request.correctionId,decision:'rejected',
        rejectReason:'Fictional native rejection witness'},carrier);
      expect(result).toEqual({status:'rejected',deferred:false});
      expect(counts()).toEqual({access:1,leave:1,subject:1});
      const configurationMode=shared?'ShareLock':'ExclusiveLock';
      const modes=await lockModes(tx,base.tenantId,request.employmentId);
      expect(modes.filter(row=>row.key==='access')).toEqual([{key:'access',mode:configurationMode}]);
      expect(modes.filter(row=>row.key==='leaveConfiguration').map(row=>row.mode))
        .toEqual(shared?['ShareLock']:['ExclusiveLock','ShareLock']);
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
  expect(await reject(first,true)).toEqual(await reject(first,false));

  const entered=[barrier(),barrier()],release=barrier();
  const concurrent=[first,second].map((request,index)=>reject(request,true,async()=>{
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
    await within(withAttendanceTenant(admin,async tx=>{
      const {carrier}=observedCarrier(tx,base.tenantId,first.employmentId,true);
      await expect(decideAttendanceCorrection(admin,{correctionId:first.correctionId,decision:'rejected',
        rejectReason:'Conflicting fictional same-subject rejection'},carrier)).rejects.toBeInstanceOf(LeaveDependencyUnavailable);
      throw rollback;
    }).catch(error=>{if(error!==rollback)throw error;}));
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
},30000);
