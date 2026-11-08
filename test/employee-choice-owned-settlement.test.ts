/** Deferred real registry mechanics; no native/socket execution is claimed. */
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {employeeChoiceOwnedSettlement} from './performance/employee-choice-owned-settlement';
import {employeeChoiceCloseRegistry,employeeChoiceWorkRegistry} from './performance/employee-choice-sql-frontier';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
const aggregate=(value:unknown)=>{expect(value).toBeInstanceOf(AggregateError);if(!(value instanceof AggregateError))throw Error('Full compound settlement failure required');return value;};
it('cannot restore the owner after socket failure until the actual callback AND its late adopted resource drain',async()=>{
 const callbacks=employeeChoiceWorkRegistry(),resources=employeeChoiceCloseRegistry(),entered=deferred(),release=deferred(),lateStarted=deferred(),lateRelease=deferred(),socket=Error('fixed socket failure'),late=Error('fixed late close failure');let restored=false,gate=true;
 resources.register(async()=>{throw socket;});
 const work=callbacks.own(async()=>{entered.resolve();try{await release.promise;}finally{resources.register(async()=>{lateStarted.resolve();await lateRelease.promise;throw late;});}});void work.catch(()=>{});
 await entered.promise;
 const settlement=employeeChoiceOwnedSettlement({stop(){gate=false;callbacks.stop();return resources.stop();},callbacks:()=>callbacks.settle(),resources:()=>resources.settle()});
 const result=settlement.catch((error:unknown)=>error).finally(()=>{restored=true;});expect(gate).toBe(false);
 await Promise.resolve();expect(restored).toBe(false);release.resolve();await lateStarted.promise;expect(restored).toBe(false);lateRelease.resolve();
 const error=aggregate(await result);expect(restored).toBe(true);expect(error.errors).toHaveLength(2);
 expect(aggregate(error.errors[0]).errors).toEqual([socket]);expect(aggregate(error.errors[1]).errors).toEqual([socket,late]);
});
it('preserves distinct socket, actual callback-finally and cleanup errors while running every mandatory phase',async()=>{
 const callbacks=employeeChoiceWorkRegistry(),entered=deferred(),release=deferred(),socket=Error('fixed socket'),inner=Error('fixed finally'),cleanup=Error('fixed cleanup');let cleanupCalled=false,drained=false;
 const work=callbacks.own(async()=>{entered.resolve();try{await release.promise;}finally{throw inner;}});void work.catch(()=>{});await entered.promise;
 const settlement=employeeChoiceOwnedSettlement({stop(){callbacks.stop();throw socket;},callbacks:async()=>{try{await callbacks.settle();}finally{drained=true;}},resources:async()=>{},cleanup(){cleanupCalled=true;throw cleanup;}});
 const result=settlement.catch((error:unknown)=>error);await Promise.resolve();expect(drained).toBe(false);expect(cleanupCalled).toBe(false);release.resolve();
 const error=aggregate(await result);expect(drained).toBe(true);expect(cleanupCalled).toBe(true);expect(error.errors[0]).toBe(socket);expect(aggregate(error.errors[1]).errors).toEqual([inner]);expect(error.errors[2]).toBe(cleanup);
});
it('closes admission synchronously and admits handoff only after successful ordered mandatory settlement',async()=>{
 const order:string[]=[];let active=true,handoff=false;
 const pending=employeeChoiceOwnedSettlement({stop(){active=false;order.push('stop');},callbacks(){order.push('callbacks');},resources(){order.push('late-resources');},cleanup(){order.push('cleanup');}}).then(()=>{handoff=true;});
 expect(active).toBe(false);expect(handoff).toBe(false);await pending;expect(order).toEqual(['stop','callbacks','late-resources','cleanup']);expect(handoff).toBe(true);
});
it('deduplicates only the identical error object and never discards a distinct same-code failure',async()=>{
 const first=Object.assign(Error('fixed first'),{code:'CONNECTION_CLOSED'}),distinct=Object.assign(Error('fixed different finally'),{code:'CONNECTION_CLOSED'});
 const error=aggregate(await employeeChoiceOwnedSettlement({stop(){throw first;},callbacks(){throw first;},resources(){throw distinct;}}).catch((error:unknown)=>error));expect(error.errors).toEqual([first,distinct]);
});
it('wires BOTH real owners through the mandatory helper for cleanup handoff and final close',()=>{
 for(const file of ['test/performance/employee-choice-native-factory-fixture.ts','test/performance/employee-choice-benchmark-owner.ts']){
  const source=readFileSync(file,'utf8');expect(source).toContain("from './employee-choice-owned-settlement'");
  expect(source.match(/await employeeChoiceOwnedSettlement\(/g)).toHaveLength(2);
  expect(source).toContain('callbacks:()=>callbacks.settle(),resources:()=>resources.settle()');expect(source).not.toContain('await stop();await');
  expect(source).toContain('closed=true;const errors:unknown[]=[];');
 }
});
