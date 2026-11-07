import {expect,it} from 'vitest';
import {assertEmployeeChoiceJitAdmission,isExpectedEmployeeChoiceJitRollback,employeeChoiceJitPolicy,employeeChoiceJitVariants,settleOwnedJitTransaction} from './performance/employee-choice-jit-policy';
const defaults={jit:'on',jit_above_cost:'100000',jit_inline_above_cost:'500000',jit_optimize_above_cost:'500000'};
it('keeps the four closed policies separate and changes only the declared JIT settings',()=>{
 expect(employeeChoiceJitVariants).toEqual(['original','unified','unified-base-jit','unified-no-jit']);
 expect(employeeChoiceJitPolicy('original',defaults)).toEqual(defaults);expect(employeeChoiceJitPolicy('unified',defaults)).toEqual(defaults);
 expect(employeeChoiceJitPolicy('unified-base-jit',defaults)).toEqual({...defaults,jit_inline_above_cost:'-1',jit_optimize_above_cost:'-1'});
 expect(employeeChoiceJitPolicy('unified-no-jit',defaults)).toEqual({...defaults,jit:'off'});
 expect(defaults).toEqual({jit:'on',jit_above_cost:'100000',jit_inline_above_cost:'500000',jit_optimize_above_cost:'500000'});
 for(const value of [undefined,null,{},'off','unified;set role postgres'])expect(()=>employeeChoiceJitPolicy(value,defaults)).toThrow('Unknown diagnostic');
});
it('observes restoration only after a successful transaction settles and returns the original value',async()=>{
 const order:string[]=[];
 expect(await settleOwnedJitTransaction(async()=>{order.push('commit');return 42;},async()=>{order.push('restored');})).toBe(42);
 expect(order).toEqual(['commit','restored']);
});
it('observes restoration after rollback and preserves the exact primary failure',async()=>{
 const primary=new Error('original SQL failure'),order:string[]=[];
 await expect(settleOwnedJitTransaction(async()=>{order.push('rollback');throw primary;},async()=>{order.push('restored');})).rejects.toBe(primary);
 expect(order).toEqual(['rollback','restored']);
});
it('retains both failures and their original cause if restoration cannot be proven',async()=>{
 const primary=new Error('original SQL failure'),restore=new Error('session changed');
 try{await settleOwnedJitTransaction(async()=>{throw primary;},async()=>{throw restore;});throw new Error('Expected diagnostic refusal');}
 catch(error){expect(error).toBeInstanceOf(AggregateError);if(!(error instanceof AggregateError))throw error;expect(error.cause).toBe(primary);expect(error.errors).toEqual([primary,restore]);}
 await expect(settleOwnedJitTransaction(async()=>42,async()=>{throw restore;})).rejects.toBe(restore);
});

it('also proves restoration after a synchronous admission failure',async()=>{
 const primary=new Error('synchronous refusal'),order:string[]=[];
 await expect(settleOwnedJitTransaction(()=>{order.push('refused');throw primary;},async()=>{order.push('restored');})).rejects.toBe(primary);
 expect(order).toEqual(['refused','restored']);
});
it('rejects compound rollback/restoration failures and blocks selection and checkout before any later callback or SQL',async()=>{
 const native=Object.assign(new Error('division by zero'),{code:'22012'}),wrapped=new Error('native query failed',{cause:native});
 expect(isExpectedEmployeeChoiceJitRollback(native)).toBe(true);expect(isExpectedEmployeeChoiceJitRollback(wrapped)).toBe(true);
 let blocked:Error|undefined,callbacks=0,sql=0;
 const checkout=async()=>{
  assertEmployeeChoiceJitAdmission(blocked);callbacks++;
  return settleOwnedJitTransaction(async()=>{sql++;throw wrapped;},async()=>{
   const failure=new Error('same-backend settings not restored');blocked=new Error('Diagnostic session poisoned',{cause:failure});throw failure;
  });
 };
 let compound:unknown;
 try{await checkout();throw new Error('Expected diagnostic refusal');}catch(error){compound=error;}
 expect(compound).toBeInstanceOf(AggregateError);
 expect(isExpectedEmployeeChoiceJitRollback(compound)).toBe(false);
 expect(isExpectedEmployeeChoiceJitRollback(new Error('outer wrapper',{cause:compound}))).toBe(false);
 await expect(checkout()).rejects.toBe(blocked);
 expect(()=>assertEmployeeChoiceJitAdmission(blocked)).toThrow('Diagnostic session poisoned');
 expect(callbacks).toBe(1);expect(sql).toBe(1);
});
