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
 let graph:readonly string[]|undefined;
 try{
  await Promise.race([ready,results.then(()=>{throw Error('Rewards readers exited before both held the shared lock');}),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Rewards shared-lock holders did not start')),3000);})]);
  const [left,right]=pids;
  expect(left).not.toBe(right);
  const key='access-configuration:'+base.tenantId;
  const [held]=await owner.db.transaction(async tx=>{
   await tx.execute(sql`set transaction read only`);
   await tx.execute(sql`set local statement_timeout='850ms'`);
   return tx.execute<{holders:number;database:string;high:string;low:string}>(sql`select count(*)::integer as holders,
    min(database::bigint)::text as database,min(classid::bigint)::text as high,min(objid::bigint)::text as low
    from pg_locks where locktype='advisory' and objsubid=1 and mode='ShareLock' and granted
    and database=(select oid from pg_database where datname=current_database())
    and pid in (${left},${right}) and ((classid::bigint<<32)|objid::bigint)=hashtextextended(${key},0)`);
  });
  expect(held.holders).toBe(2);
  const lock=[held.database,held.high,held.low,1].join(',');
  graph=[
   'Process '+left+' waits for ExclusiveLock on advisory lock ['+lock+']; blocked by process '+right+'.',
   'Process '+right+' waits for ExclusiveLock on advisory lock ['+lock+']; blocked by process '+left+'.',
  ];
  startChooser=true;
  release();
 }finally{
  clearTimeout(timer);
  release();
  await results;
 }
 const outcomes=await results;
 const failures=outcomes.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
 expect(failures.map(result=>pgSqlState(result.reason))).toContain('40P01');
 expect(failures.every(result=>['40P01','55P03'].includes(pgSqlState(result.reason)??''))).toBe(true);
 const deadlock=failures.find(result=>pgSqlState(result.reason)==='40P01')!;
 type NativeCause={code?:unknown;detail?:unknown;cause?:unknown};
 let cause=deadlock.reason as NativeCause|null;
 let detail:unknown;
 for(let depth=0;depth<4&&cause&&typeof cause==='object';depth++){
  if(cause.code==='40P01'){detail=cause.detail;break;}
  cause=cause.cause as NativeCause|null;
 }
 const observedEdges=typeof detail==='string'?detail.split('\n').map(line=>line.trim()):[];
 expect(graph?.every(edge=>observedEdges.includes(edge))).toBe(true);
},15000);
