import {afterEach,expect,it,vi} from 'vitest';
import {createTenantWriteAdmission} from '../db/tenant-write-admission';
afterEach(()=>vi.useRealTimers());
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}

it('bounds waiting memory, preserves tenant order and lets another tenant use an idle lane',async()=>{
 const gate=createTenantWriteAdmission({capacity:2,maxWaiting:2,waitMs:1000}),held=deferred(),entered=deferred();
 const order:string[]=[];const first=gate.run('A',async()=>{entered.resolve();await held.promise;order.push('a1');});
 await entered.promise;
 const second=gate.run('a',async()=>{order.push('a2');}),third=gate.run('A',async()=>{order.push('a3');});
 await expect(gate.run('a',async()=>{throw Error('must never start');})).rejects.toMatchObject({code:'queue-full'});
 // The full pending queue refuses before starting any extra command.
 expect(gate.snapshot()).toMatchObject({active:1,waiting:2});
 held.resolve();await Promise.all([first,second,third]);expect(order).toEqual(['a1','a2','a3']);
 const otherHeld=deferred(),otherEntered=deferred();
 const active=gate.run('a',async()=>{otherEntered.resolve();await otherHeld.promise;});await otherEntered.promise;
 await gate.run('b',async()=>{order.push('b');});otherHeld.resolve();await active;
 expect(order.at(-1)).toBe('b');expect(gate.snapshot()).toMatchObject({active:0,waiting:0});
});

it('expires or cancels only unstarted commands and never retries an uncertain admitted outcome',async()=>{
 vi.useFakeTimers();const gate=createTenantWriteAdmission({capacity:1,maxWaiting:2,waitMs:100}),held=deferred(),entered=deferred();
 const first=gate.run('a',async()=>{entered.resolve();await held.promise;});await entered.promise;
 const controller=new AbortController(),reason=new Error('command cancelled before admission'),write=vi.fn(async()=>{});
 const cancelled=gate.run('b',write,controller.signal),cancelledResult=expect(cancelled).rejects.toBe(reason);
 controller.abort(reason);await cancelledResult;
 const timeout=expect(gate.run('b',write)).rejects.toMatchObject({code:'queue-timeout'});
 await vi.advanceTimersByTimeAsync(100);await timeout;expect(write).not.toHaveBeenCalled();
 expect(gate.snapshot()).toMatchObject({active:1,waiting:0});held.resolve();await first;
 const uncertain=new Error('response lost after native outcome'),once=vi.fn(async()=>{throw uncertain;});
 await expect(gate.run('b',once)).rejects.toBe(uncertain);expect(once).toHaveBeenCalledTimes(1);
 await gate.run('b',write);expect(write).toHaveBeenCalledTimes(1);expect(gate.snapshot()).toMatchObject({active:0,waiting:0});
});
