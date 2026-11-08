/** TEST-only observation of the original classification before LabelBulkError.
 * No SQL, raw message, authority, replacement error or business result escapes. */
import type {pgErrorChain} from '../../lib/db-error';
import {types} from 'node:util';
import {rewardPolicyNativeGuards} from './rewards-audit-policy-native-guards';
export type RewardPolicyNativeSaveObservation=Readonly<{sqlstate:string|null;nativeGuard?:typeof rewardPolicyNativeGuards[number]['code']}>;
export type RewardPolicyNativeSaveSnapshot=Readonly<{complete:boolean;observations:readonly RewardPolicyNativeSaveObservation[]}>;
export function rewardPolicyNativeSaveObservation(actualChain:typeof pgErrorChain){
 const rows:RewardPolicyNativeSaveObservation[]=[],seen=new Set<unknown>();let active=false,used=false,uncertain=false;
 // Follow only original own DATA edges at the depth actually selected from
 // the already-returned chain. Accessors, inherited/opaque paths and proxies
 // cannot attest the native cause identity; never call a trap to resolve them.
 function identity(error:unknown,code:string,index:number){
  let current=error;const visited=new Set<unknown>();
  for(let depth=0;depth<=index;depth++){
   if(current===null||typeof current!=='object'||types.isProxy(current)||visited.has(current))return undefined;
   visited.add(current);const state=Object.getOwnPropertyDescriptor(current,'code');
   if(state&&!('value'in state))return undefined;
   if(depth===index)return state&&'value'in state&&state.value===code?current:undefined;
   const cause=Object.getOwnPropertyDescriptor(current,'cause');
   if(!cause||!('value'in cause))return undefined;current=cause.value;
  }
  return undefined;
 }
 function chain(error:unknown):ReturnType<typeof pgErrorChain>{
  const original=actualChain(error); // preserve actual array/result/throw identity
  if(active){try{
   // EXACT lib/db-error.pgSqlState first-valid-five-character selection over
   // the ORIGINAL pgErrorChain array. Never call a classifier on error again.
   const selected=original.find((l) => /^[0-9A-Z]{5}$/.test(l.code ?? ''));
   const sqlstate=selected?.code??null;
   if(sqlstate===null){uncertain=true;return original;}
   const originalError=identity(error,sqlstate,original.indexOf(selected!));
   if(originalError===undefined){uncertain=true;return original;}
   if(!seen.has(originalError)){
    if(rows.length===64){uncertain=true;return original;}seen.add(originalError);
    const known=rewardPolicyNativeGuards.find(guard=>guard.message===selected?.message&&guard.sqlstates.some(code=>code===sqlstate));
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
