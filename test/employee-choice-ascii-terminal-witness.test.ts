import {expect,it} from 'vitest';
import {employeeChoiceAsciiTerminalWitness} from './performance/employee-choice-ascii-terminal-witness';
const held=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};};
it('starts every terminal witness false and cannot inherit or expose mutable accepted state',async()=>{
 const first=employeeChoiceAsciiTerminalWitness();await first.prove('prototype',async()=>{});await first.prove('logging',async()=>{});expect(first.snapshot().complete).toBe(true);
 const next=employeeChoiceAsciiTerminalWitness(),copy=next.snapshot();copy.prototype=true;copy.logging=true;copy.complete=true;
 expect(next.snapshot()).toEqual({prototype:false,logging:false,complete:false});
});
it('accepts each terminal proof only AFTER its actual asynchronous guard fully settles',async()=>{
 const state=employeeChoiceAsciiTerminalWitness(),entered=held(),release=held();
 const pending=state.prove('prototype',async()=>{entered.resolve();await release.promise;});await entered.promise;
 await state.prove('logging',async()=>{});expect(state.snapshot()).toEqual({prototype:false,logging:true,complete:false});
 release.resolve();await pending;expect(state.snapshot()).toEqual({prototype:true,logging:true,complete:true});
});
it('retains a failed restoration while permitting the independent mandatory guard to run',async()=>{
 const state=employeeChoiceAsciiTerminalWitness(),failure=Error('Fixed native restoration refusal');let logging=0;
 await expect(state.prove('prototype',async()=>{throw failure;})).rejects.toBe(failure);
 await state.prove('logging',async()=>{logging++;});expect(logging).toBe(1);expect(state.snapshot()).toEqual({prototype:false,logging:true,complete:false});
});
it('refuses duplicate terminal guard execution and source-bypassed unknown kinds before callbacks run',async()=>{
 const state=employeeChoiceAsciiTerminalWitness();let executions=0;await state.prove('prototype',async()=>{executions++;});
 expect(()=>state.prove('prototype',async()=>{executions++;})).toThrow();
 const untyped:unknown=state.prove;if(typeof untyped!=='function')throw Error('Actual terminal method absent');
 expect(()=>untyped('foreign',async()=>{executions++;})).toThrow();expect(executions).toBe(1);expect(state.snapshot().complete).toBe(false);
});
