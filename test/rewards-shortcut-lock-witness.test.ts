/** Fictional diagnosis of the current Rewards Return chooser's Access lock order. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {assertAiPrincipalTx} from '../core/ai-principal';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {readRewardsReturnChoicesTx} from '../core/assistant-actions/rewards-return-source';
import {withTenant,type SessionContext} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

it('witnesses two native Rewards Return chooser transactions upgrading the same Access lock',async()=>{
 await resetDb();
 const base=await seedBase();
 await setModule(base.tenantId,'assistant','active');
 await setModule(base.tenantId,'rewards','active');
 const actors:SessionContext[]=[];
 for(const name of ['First','Second']){
  const {personId}=await hireEmployee(adminCtx(base),{
   person:{fullName:'Fictional '+name+' Rewards Reader',primaryEmail:name.toLowerCase()+'@reward-lock.test'},
   companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01',
  });
  const userId=await createAppUser(base.tenantId,personId,'hr_admin');
  await grantAssistant(adminCtx(base),{appUserId:userId});
  actors.push({...await entitledCtx(base),userId,personId});
 }

 const pids:number[]=[];
 let startChooser=false;
 let declareReady!:()=>void,release!:()=>void;
 const ready=new Promise<void>(resolve=>{declareReady=resolve;});
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const signal=AbortSignal.timeout(9000);
 const results=Promise.allSettled(actors.map(actor=>withTenant(actor,async tx=>{
  await tx.execute(sql`set transaction read only`);
  await tx.execute(sql`set local statement_timeout='2500ms'`);
  await assertAiPrincipalTx(tx,actor);
  const [identity]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);
  pids.push(identity.pid);
  if(pids.length===2)declareReady();
  await gate;
  if(!startChooser)return;
  signal.throwIfAborted();
  return readRewardsReturnChoicesTx(tx,actor);
 },{readSignal:signal})));
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([ready,results.then(()=>{throw Error('Rewards readers exited before both held the shared lock');}),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Rewards shared-lock holders did not start')),3000);})]);
  const [left,right]=pids;
  expect(left).not.toBe(right);
  const key='access-configuration:'+base.tenantId;
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`set transaction read only`);
   await tx.execute(sql`set local statement_timeout='850ms'`);
   const [held]=await tx.execute<{holders:number}>(sql`select count(*)::integer as holders
    from pg_locks where locktype='advisory' and objsubid=1 and mode='ShareLock' and granted
    and database=(select oid from pg_database where datname=current_database())
    and pid in (${left},${right}) and ((classid::bigint<<32)|objid::bigint)=hashtextextended(${key},0)`);
   expect(held.holders).toBe(2);
   startChooser=true;
   release();
   let bothBlocked=false;
   const deadline=performance.now()+850;
   do{
    const [observation]=await tx.execute<{waiters:number}>(sql`select count(*)::integer as waiters
     from pg_locks l join pg_stat_activity a on a.pid=l.pid
     where l.locktype='advisory' and l.objsubid=1 and l.mode='ExclusiveLock' and not l.granted
     and l.database=(select oid from pg_database where datname=current_database())
     and a.datname=current_database() and a.usename='ai_hr_app'
     and ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended(${key},0)
     and ((l.pid=${left} and ${right}::integer=any(pg_blocking_pids(l.pid)))
      or (l.pid=${right} and ${left}::integer=any(pg_blocking_pids(l.pid))))`);
    bothBlocked=performance.now()<deadline&&observation.waiters===2;
    if(!bothBlocked)await new Promise(resolve=>setTimeout(resolve,10));
   }while(!bothBlocked&&performance.now()<deadline);
   expect(bothBlocked).toBe(true);
  });
 }finally{
  clearTimeout(timer);
  release();
  await results;
 }
 const outcomes=await results;
 const failures=outcomes.flatMap(result=>result.status==='rejected'?[pgSqlState(result.reason)]:[]);
 expect(failures.length).toBeGreaterThan(0);
 expect(failures.every(code=>code==='40P01'||code==='55P03')).toBe(true);
},15000);
