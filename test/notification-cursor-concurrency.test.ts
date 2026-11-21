/** Real PostgreSQL interleavings. No trigger is disabled and no sequence is injected.
 * The owner connection creates fictional events, as notifications.test.ts does.
 * The actual projector runs through its normal current-principal/RLS transaction.
 */
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {dispatchNotifications} from '../core/notifications';
import {hireEmployee} from '../core/org';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting} from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

function barrier(){
 let resolve!:()=>void;
 const promise=new Promise<void>(done=>{resolve=done;});
 return {promise,resolve};
}
async function bounded<T>(work:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>reject(new Error('Cursor probe barrier timed out')),8000);
 })]);}finally{clearTimeout(timer);}
}
// 074a61d0f (migration 5090) seals the audit chain at commit: an audited insert no longer takes the tenant's
// audit-chain key and holds it to commit, so B's insert no longer waits behind A. The interleaving this file exists
// for is unchanged: B holds a sequence between A's two events and is still uncommitted while A commits and the
// projector runs. This proves the seal's side of it on the real backends: A is open without the key, and B is not
// blocked by A.
async function expectInsertNotWaitingOnAudit(tenant:string,holder:number,writer:number){
 const [row]=await owner.client`select
  (select state from pg_stat_activity where pid=${holder}) as holder_state,
  exists(select 1 from pg_catalog.pg_locks l,(select hashtext('audit-chain:'||${tenant}::text)::bigint as k) ck
   where l.pid=${holder} and l.locktype='advisory' and l.granted and l.objsubid=1
    and l.classid::bigint=((ck.k>>32)&4294967295) and l.objid::bigint=(ck.k&4294967295)) as holder_has_key,
  exists(select 1 from pg_stat_activity where pid=${writer} and wait_event_type='Lock') as writer_waiting,
  ${holder}::integer=any(pg_blocking_pids(${writer})) as writer_blocked`;
 expect(row).toEqual({holder_state:'idle in transaction',holder_has_key:false,writer_waiting:false,writer_blocked:false});
}

for(const chain of [false,true]){
 for(const scenario of ['single-event-control','interleaved-commit','interleaved-rollback'] as const){
  it(`projects every committed event exactly once: ${scenario}, chain=${chain}`,async()=>{
   await resetDb();
   const base=await seedBase();
   await setModule(base.tenantId,'notifications','active');
   await setSetting(base.tenantId,'audit.hash_chain_enabled',chain);
   const recipient=await hireEmployee(adminCtx(base),{
    person:{fullName:'Fictional cursor subject',primaryEmail:randomUUID()+'@example.invalid'},
    companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01',
   });
   const actor=adminCtx(base);
   await dispatchNotifications(actor);
   const ids={a1:randomUUID(),a2:randomUUID(),b:randomUUID()};
   const sequences:Record<string,number>={};
   async function insert(tx:postgres.TransactionSql,key:keyof typeof ids){
    const [row]=await tx`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,
     actor_type,subject_employment_id,payload)
     values(${ids[key]}::uuid,${base.tenantId}::uuid,'cursor-probe',${ids[key]}::uuid,
     'toil.accrued','system',${recipient.employmentId}::uuid,'{"daysCredited":1}'::jsonb)
     returning sequence`;
    sequences[key]=Number(row.sequence);
   }
   const aReady=barrier(),continueA=barrier(),bReady=barrier(),bInserted=barrier(),releaseB=barrier();
   let aPid=0,bPid=0;
   const rollback=new Error('Intentional B rollback control');
   const a=owner.client.begin(async tx=>{
    await tx`set local statement_timeout='12s'`;
    await tx`select set_config('app.audit_hash_chain',${chain?'on':'off'},true)`;
    const [pid]=await tx`select pg_backend_pid() as pid`;aPid=pid.pid;
    await insert(tx,'a1');aReady.resolve();await continueA.promise;
    if(scenario!=='single-event-control')await insert(tx,'a2');
   });
   // Attach an observer immediately so setup failures are reported without unhandled rejections.
   void a.catch(()=>{});
   let b:Promise<unknown>|undefined;
   try{
    await bounded(Promise.race([aReady.promise,a.then(()=>{throw Error('A ended before its barrier');})]));
    b=owner.client.begin(async tx=>{
     await tx`set local statement_timeout='12s'`;
     await tx`select set_config('app.audit_hash_chain',${chain?'on':'off'},true)`;
     const [pid]=await tx`select pg_backend_pid() as pid`;bPid=pid.pid;bReady.resolve();
     await insert(tx,'b');bInserted.resolve();await releaseB.promise;
     if(scenario==='interleaved-rollback')throw rollback;
    }).catch(error=>{if(error!==rollback)throw error;});
    void b.catch(()=>{});
    await bounded(Promise.race([bReady.promise,b.then(()=>{throw Error('B ended before its barrier');})]));
    // B's insert completes while A is still open (a wait behind A would time out this barrier).
    await bounded(Promise.race([bInserted.promise,b.then(()=>{throw Error('B ended before insert barrier');})]));
    await expectInsertNotWaitingOnAudit(base.tenantId,aPid,bPid);
    continueA.resolve();await bounded(a);
    expect(sequences.a1).toBeLessThan(sequences.b);
    if(scenario!=='single-event-control')expect(sequences.b).toBeLessThan(sequences.a2);
    const first=await dispatchNotifications(actor,{limit:1});
    const firstRest=await dispatchNotifications(actor,{limit:1});
    const [beforeCommit]=await owner.client`select last_sequence from notification_cursor where tenant_id=${base.tenantId}::uuid`;
    releaseB.resolve();await bounded(b);
    const second=await dispatchNotifications(actor,{limit:1});
    await dispatchNotifications(actor,{limit:1});
    const third=await dispatchNotifications(actor,{limit:1});
    const committed=await owner.client`select id,chain_seq from domain_event where id in (${ids.a1}::uuid,${ids.a2}::uuid,${ids.b}::uuid) order by id`;
    // Chain positions are taken at each transaction's seal, so they are read from the committed rows.
    const chainSequences=Object.fromEntries(committed.map(row=>[row.id,row.chain_seq===null?null:Number(row.chain_seq)]));
    const projected=await owner.client`select source_event_id from notification
     where source_event_id in (${ids.a1}::uuid,${ids.a2}::uuid,${ids.b}::uuid) order by source_event_id`;
    console.info('[architecture-cursor-probe]',JSON.stringify({scenario,chain,sequences,chainSequences,
     beforeCommitCursor:Number(beforeCommit.last_sequence),first,firstRest,second,third,
     committedCount:committed.length,projectedCount:projected.length,
     missingCommittedIds:committed.map(row=>row.id).filter(id=>!projected.some(row=>row.source_event_id===id))}));
    const expectedCount=scenario==='interleaved-commit'?3:2;
    expect(committed).toHaveLength(expectedCount);
    for(const value of Object.values(chainSequences)){
     if(chain)expect(value).toBeGreaterThan(0);else expect(value).toBeNull();
    }
    expect(projected.map(row=>row.source_event_id)).toEqual(committed.map(row=>row.id));
    expect(third.created).toBe(0);
   }finally{
    continueA.resolve();releaseB.resolve();
    await Promise.allSettled([a,...(b?[b]:[])]);
   }
  },30000);
 }
}
