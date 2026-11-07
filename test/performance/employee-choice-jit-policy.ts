/** Diagnostic-only closed policy matrix. No application or borrowed-Tx API. */
export const employeeChoiceJitVariants=['original','unified','unified-base-jit','unified-no-jit']as const;
export type EmployeeChoiceJitVariant=typeof employeeChoiceJitVariants[number];
export type EmployeeChoiceJitSettings={jit:string;jit_above_cost:string;jit_inline_above_cost:string;jit_optimize_above_cost:string};
export function employeeChoiceJitPolicy(variant:unknown,defaults:EmployeeChoiceJitSettings){
 switch(variant){
  case 'original':case 'unified':return {...defaults};
  case 'unified-base-jit':return {...defaults,jit:'on',jit_inline_above_cost:'-1',jit_optimize_above_cost:'-1'};
  case 'unified-no-jit':return {...defaults,jit:'off'};
  default:throw new Error('Unknown diagnostic employee-choice JIT policy');
 }
}
/** Wait for COMMIT/ROLLBACK before observing the same owned physical session.
 * An aborted transaction never receives cleanup SQL. Preserve its original error
 * even if the independent post-transaction restoration proof also fails. */
export async function settleOwnedJitTransaction<T>(transaction:()=>Promise<T>,verifyRestored:()=>Promise<void>):Promise<T>{
 const outcome=await Promise.resolve().then(transaction).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
 try{await verifyRestored();}
 catch(restorationError){
  if(!outcome.ok)throw new AggregateError([outcome.error,restorationError],'Diagnostic transaction failed and session restoration could not be proven',{cause:outcome.error});
  throw restorationError;
 }
 if(!outcome.ok)throw outcome.error;
 return outcome.value;
}
