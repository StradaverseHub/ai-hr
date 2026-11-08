/** TEST-only observation of the original classification before LabelBulkError.
 * No SQL, raw message, authority, replacement error or business result escapes. */
import type {pgErrorChain,pgSqlState} from '../../lib/db-error';
import {rewardPolicyNativeGuards} from './rewards-audit-policy-native-guards';
export type RewardPolicyNativeSaveObservation=Readonly<{sqlstate:string|null;nativeGuard?:typeof rewardPolicyNativeGuards[number]['code']}>;
export type RewardPolicyNativeSaveSnapshot=Readonly<{complete:boolean;observations:readonly RewardPolicyNativeSaveObservation[]}>;
export function rewardPolicyNativeSaveObservation(actualChain:typeof pgErrorChain,actualState:typeof pgSqlState){
 const rows:RewardPolicyNativeSaveObservation[]=[],seen=new Set<unknown>();let active=false,used=false,uncertain=false;
 // Identity comes from the original native object, not a reconstructed record.
 // Descriptor reads never call another error getter or copy raw query text.
 function identity(error:unknown,code:string|null){
  let current=error;const visited=new Set<unknown>();
  for(let depth=0;depth<4&&current!==null&&typeof current==='object'&&!visited.has(current);depth++){
   visited.add(current);const state=Object.getOwnPropertyDescriptor(current,'code');
   if(code!==null&&state&&'value'in state&&state.value===code)return current;
   const cause=Object.getOwnPropertyDescriptor(current,'cause');current=cause&&'value'in cause?cause.value:undefined;
  }
  return error;
 }
 function chain(error:unknown):ReturnType<typeof pgErrorChain>{
  const original=actualChain(error); // preserve actual array/result/throw identity
  if(active){try{
   // The actual pgSqlState uses its own lexical pgErrorChain; this extra native
   // classification cannot recurse through the imported admin observation seam.
   const sqlstate=actualState(error)??null;
   if(sqlstate!==null&&!/^[0-9A-Z]{5}$/.test(sqlstate)){uncertain=true;return original;}
   const originalError=identity(error,sqlstate);
   if(!seen.has(originalError)){
    if(rows.length===64){uncertain=true;return original;}seen.add(originalError);
    const native=original.find(link=>link.code===sqlstate),known=rewardPolicyNativeGuards.find(guard=>guard.message===native?.message&&guard.sqlstates.some(code=>code===sqlstate));
    rows.push(Object.freeze({sqlstate,...(known?{nativeGuard:known.code}:{})}));
   }
  }catch{uncertain=true;}}
  return original;
 }
 return Object.freeze({chain,
  async armed<T>(work:()=>PromiseLike<T>):Promise<T>{
   if(active||used)throw Error('Exactly one owned armed Catalogue save observation required');
   used=true;active=true;try{return await work();}finally{active=false;}
  },
  snapshot():RewardPolicyNativeSaveSnapshot{return Object.freeze({complete:!active&&!uncertain,observations:Object.freeze([...rows])});},
  knownRefusals(){return rows.flatMap(row=>{const known=rewardPolicyNativeGuards.find(guard=>guard.code===row.nativeGuard&&guard.sqlstates.some(code=>code===row.sqlstate));return known?[{code:row.sqlstate!,message:known.message}]:[];});},
 });
}
