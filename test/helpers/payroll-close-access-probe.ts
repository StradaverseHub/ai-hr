/** Close Access admission witness: since 915d5a06 Close try-locks Access and retries a miss after
 * returning its connection instead of joining the PostgreSQL wait queue. Observes the actual try
 * result on the driver's normal query path; no lock, result or authorization is substituted.
 * 7b6dceb82 (reader/writer Access lock) moved the payroll period owners to the SHARED try
 * (tryLockAccessConfigurationReadTx), so either try form on the tenant's Access key is the witness. */
import {sql} from 'drizzle-orm';
import {expect,vi} from 'vitest';
import {client} from '../../db/client';
import {owner} from '../harness';

export function observeCloseAccessMisses(tenantId:string){
 const begin=client.begin.bind(client),accessKey='access-configuration:'+tenantId;
 let misses=0;
 const spy=vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{
  const index=args.findIndex(value=>typeof value==='function');
  const callback=args[index] as (native:typeof client)=>unknown;
  let missed=false;
  args[index]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){
   if(key==='unsafe')return (...query:unknown[])=>{
    const pending=Reflect.apply(target.unsafe,target,query);
    if(typeof query[0]==='string'&&/pg_try_advisory_xact_lock(?:_shared)?\(/.test(query[0])&&Array.isArray(query[1])&&query[1].includes(accessKey)){
     void (pending as PromiseLike<readonly {acquired?:boolean;owned?:boolean}[]>).then(rows=>{
      if(rows[0]?.acquired===false||rows[0]?.owned===false)missed=true;
     },()=>undefined);
    }
    return pending;
   };
   return Reflect.get(target,key,receiver);
  }}));
  const transaction=Reflect.apply(begin,client,args) as PromiseLike<unknown>;
  const settled=()=>{if(missed)misses++;};
  void transaction.then(settled,()=>undefined);
  return transaction;
 }) as typeof client.begin);
 return {misses:()=>misses,restore:()=>spy.mockRestore()};
}

/** No backend is queued behind the Access owner while Close keeps retrying its completed misses. */
export async function expectCooperativeCloseAdmission(probe:ReturnType<typeof observeCloseAccessMisses>,ownerPid:number){
 for(const completedMisses of [1,2]){
  await expect.poll(probe.misses,{timeout:2000,interval:10}).toBeGreaterThanOrEqual(completedMisses);
  const [row]=await owner.db.execute<{blocked:boolean}>(sql`select exists(
   select 1 from pg_stat_activity a where a.pid<>pg_backend_pid() and ${ownerPid}=any(pg_blocking_pids(a.pid))
  ) as blocked`);
  expect(row.blocked).toBe(false);
 }
}
