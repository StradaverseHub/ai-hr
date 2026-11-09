/** Pure mandatory settlement order. No socket, database or admission is created.
 * stop MUST close its owner's frontier synchronously before returning a promise.
 * A failed close never exempts actual callbacks or their late adopted resources. */
type Phase=()=>unknown|PromiseLike<unknown>;
export async function employeeChoiceOwnedSettlement(phases:{stop:Phase;callbacks:Phase;resources:Phase;cleanup?:Phase}){
 const errors:unknown[]=[],seen=new WeakSet<object>();
 for(const phase of [phases.stop,phases.callbacks,phases.resources,...(phases.cleanup?[phases.cleanup]:[])]){
  try{await phase();}catch(error){
   if(error!==null&&(typeof error==='object'||typeof error==='function')){if(seen.has(error))continue;seen.add(error);}
   errors.push(error);
  }
 }
 if(errors.length)throw new AggregateError(errors,'Employee owned phases refused after complete mandatory settlement');
}
