import {expect,it} from 'vitest';
import {AttendanceBridgeOwnedPhases} from './helpers/attendance-bridge-owned-phase';

const gate=()=>{let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return{promise,open};};
it('registers before the first microtask and prevents reset or a second checkout while owned work is pending',async()=>{
 const phases=new AttendanceBridgeOwnedPhases(),entered=gate(),release=gate(),calls:string[]=[];
 const phase=phases.start(async step=>{await step(async()=>{calls.push('checkout');entered.open();await release.promise;});},async()=>{calls.push('restore');});
 expect(()=>phases.assertReady()).toThrow('unsettled');
 expect(()=>phases.start(async()=>{calls.push('successor');},async()=>{})).toThrow('unsettled');
 await entered.promise;let drained=false;const draining=phases.drain().then(()=>{drained=true;});
 await Promise.resolve();expect(drained).toBe(false);release.open();await phase.result;await draining;
 expect(calls).toEqual(['checkout','restore']);phases.assertReady();
});
it('a deferred deadline waits for in-flight SQL and complete restoration, and stops every later work callback',async()=>{
 const phases=new AttendanceBridgeOwnedPhases(),entered=gate(),sql=gate(),restoring=gate(),restored=gate(),calls:string[]=[];
 const phase=phases.start(async step=>{
  await step(async()=>{calls.push('SQL-start');entered.open();await sql.promise;calls.push('SQL-settled');});
  await step(async()=>{calls.push('forbidden-next-SQL');});
 },async()=>{calls.push('restoration-start');restoring.open();await restored.promise;calls.push('catalogue-restored');});
 await entered.promise;let finished=false;const hook=phase.stopAndDrain().then(()=>{finished=true;});
 const rejected=expect(phase.result).rejects.toThrow('phase stopped');sql.open();await restoring.promise;
 expect(finished).toBe(false);expect(()=>phases.assertReady()).toThrow('unsettled');
 restored.open();await rejected;await hook;phases.assertReady();
 expect(calls).toEqual(['SQL-start','SQL-settled','restoration-start','catalogue-restored']);
});
it('a deadline before scheduling refuses the first checkout while still executing owned restoration',async()=>{
 const phases=new AttendanceBridgeOwnedPhases(),calls:string[]=[];
 const phase=phases.start(async step=>{await step(async()=>{calls.push('forbidden-checkout');});},async()=>{calls.push('restore');});
 const hook=phase.stopAndDrain();await expect(phase.result).rejects.toThrow('phase stopped');await hook;
 expect(calls).toEqual(['restore']);phases.assertReady();
});
it('failed restoration permanently poisons reset, afterAll admission and every later phase',async()=>{
 const phases=new AttendanceBridgeOwnedPhases(),failure=Error('Uncertain native catalogue restoration'),calls:string[]=[];
 const phase=phases.start(async()=>{calls.push('work');},async()=>{throw failure;});
 await expect(phase.result).rejects.toBe(failure);await expect(phase.stopAndDrain()).rejects.toBe(failure);
 await expect(phases.drain()).rejects.toBe(failure);expect(()=>phases.assertReady()).toThrow(failure);
 expect(()=>phases.start(async()=>{calls.push('forbidden');},async()=>{})).toThrow(failure);expect(calls).toEqual(['work']);
});
it('retains both the original work failure and failed restoration rather than replacing the first with cleanup',async()=>{
 const phases=new AttendanceBridgeOwnedPhases(),work=Error('Original work failure'),restore=Error('Actual restoration failure');
 const phase=phases.start(async()=>{throw work;},async()=>{throw restore;});
 let caught:unknown;try{await phase.result;}catch(error){caught=error;}
 expect(caught).toBeInstanceOf(AggregateError);if(!(caught instanceof AggregateError))throw Error('Both owned failures must be retained');
 expect(caught.errors).toEqual([work,restore]);await expect(phase.stopAndDrain()).rejects.toBe(caught);
 await expect(phases.drain()).rejects.toBe(caught);expect(()=>phases.assertReady()).toThrow(caught);
});
