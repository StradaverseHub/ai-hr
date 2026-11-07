import { describe, expect, it, vi } from 'vitest';
import { createMobileTaskReadFlights } from '../core/mobile-task-read-flight';
import type { SessionContext } from '../db/client';
const modules = { attendance:true, claims:true, performance:false, rewards:false };
const ctx:SessionContext = {tenantId:'tenant-a',userId:'user-a',personId:'person-a',roles:['manager'],grants:[{role:'manager',companyId:'company-a'}]};
const deferred = <T,>() => { let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject}; };

describe('simultaneous mobile task display reads',()=>{
 it('shares work for identical verified contexts but starts fresh after completion',async()=>{
  const store=createMobileTaskReadFlights<number[]>(),flight=deferred<number[]>(),load=vi.fn(()=>flight.promise);
  const first=store.read(ctx,modules,load),second=store.read({...ctx},modules,load);
  await Promise.resolve();expect(load).toHaveBeenCalledOnce();
  flight.resolve([1,2]);expect(await first).toEqual([1,2]);expect(await second).toEqual([1,2]);
  await store.read(ctx,modules,load);expect(load).toHaveBeenCalledTimes(2);
 });
 it('isolates tenant, actor, person, grant, role, entitlements and module differences',async()=>{
  const store=createMobileTaskReadFlights<number>(),flight=deferred<number>(),load=vi.fn(()=>flight.promise);
  const changes:SessionContext[]=[ctx,{...ctx,tenantId:'tenant-b'},{...ctx,userId:'user-b'},{...ctx,personId:'person-b'},
   {...ctx,roles:['hr_admin']},{...ctx,grants:[{role:'manager',companyId:'company-b'}]},
   {...ctx,entitlementsExempt:'seeding'},{...ctx,entitlementsError:'unresolved'}];
  const pending=changes.map(owner=>store.read(owner,modules,load));pending.push(store.read(ctx,{...modules,claims:false},load));
  await Promise.resolve();expect(load).toHaveBeenCalledTimes(changes.length+1);flight.resolve(1);await Promise.all(pending);
 });
 it('does not attach a later retry to an old unfinished read',async()=>{
  let time=0;const store=createMobileTaskReadFlights<number>(32,()=>time),first=deferred<number>(),second=deferred<number>();
  const a=store.read(ctx,modules,()=>first.promise);time=2001;
  const b=store.read(ctx,modules,()=>second.promise);second.resolve(2);expect(await b).toBe(2);first.resolve(1);expect(await a).toBe(1);
 });
 it('removes failures and bypasses reuse at capacity instead of rejecting unrelated actors',async()=>{
  const store=createMobileTaskReadFlights<number>(1),flight=deferred<number>(),load=vi.fn(()=>flight.promise);
  const failed=store.read(ctx,modules,load);const check=expect(failed).rejects.toThrow('temporary');
  const other=vi.fn(async()=>2);expect(await store.read({...ctx,userId:'other'},modules,other)).toBe(2);
  flight.reject(new Error('temporary'));await check;
  expect(await store.read(ctx,modules,async()=>3)).toBe(3);
 });
});
