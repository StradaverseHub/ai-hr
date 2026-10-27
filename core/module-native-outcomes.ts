/** Own association commands only. No native action execution, provider, ratings-as-truth or causal
 * credit. Existing job verifier owns Access -> shared release -> shared signal before native source
 * configuration/subject/row ownership, then association custody. No refusal is caught inside a Tx. */
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {RecordNativeOutcomeAssociation,NativeOutcomeAssociationId} from '../lib/ai/module-native-outcomes';
import {assertAiPrincipalTx} from './ai-principal';
import {readVerifiedOwnGovernedJobProvenanceTx} from './module-agent-releases';
import {lockNativeOutcomeCustodyTx,nominateOwnNativeOutcomeJobTx,readVerifiedNativeOutcomeAssociationTx,recordVerifiedNativeOutcomeAssociationTx} from './module-native-outcome-references';
import type {NativeOutcomeServerContext} from './assistant-actions/completed-outcome-readers';
const capture=(ctx:SessionContext)=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const serverCapture=(server:NativeOutcomeServerContext)=>Object.freeze({notificationIdentity:server.notificationIdentity});
export class NativeOutcomeUnavailable extends Error{constructor(){super('This outcome link needs a fresh look. Please check your access and completed action.');this.name='NativeOutcomeUnavailable';}}
export async function recordOwnNativeOutcomeAssociation(supplied:SessionContext,value:unknown,server:NativeOutcomeServerContext={}){
 const ctx=capture(supplied);let input;try{input=RecordNativeOutcomeAssociation.parse(structuredClone(value));}catch{throw new NativeOutcomeUnavailable();}const capability=serverCapture(server);
 try{return await withTenant(ctx,async tx=>{
  await boundNativeOutcomeTransactionTx(tx);
  const provenance=await readVerifiedOwnGovernedJobProvenanceTx(tx,ctx,input.jobId);
  return recordVerifiedNativeOutcomeAssociationTx(tx,ctx,input,provenance,capability);
 });}catch{throw new NativeOutcomeUnavailable();}
}
export async function reopenOwnNativeOutcomeAssociation(supplied:SessionContext,value:unknown,server:NativeOutcomeServerContext={}){
 const ctx=capture(supplied);let input;try{input=NativeOutcomeAssociationId.parse(structuredClone(value));}catch{throw new NativeOutcomeUnavailable();}const capability=serverCapture(server);
 try{return await withTenant(ctx,async tx=>{
  await boundNativeOutcomeTransactionTx(tx);
  await assertAiPrincipalTx(tx,ctx);
  const jobId=await nominateOwnNativeOutcomeJobTx(tx,ctx,input.associationId);
  const provenance=await readVerifiedOwnGovernedJobProvenanceTx(tx,ctx,jobId);
  return (await readVerifiedNativeOutcomeAssociationTx(tx,ctx,input.associationId,provenance,capability)).view;
 });}catch{throw new NativeOutcomeUnavailable();}
}
/** Identity-only self-erasure survives Assistant/native module/grant revocation, without row echoes.
 * Static DELETE has no WHERE/RETURNING: normal own-user RLS supplies the entire permitted scope. */
export async function eraseOwnNativeOutcomeAssociations(supplied:SessionContext){
 const ctx=capture(supplied);try{return await withTenant(ctx,async tx=>{await boundNativeOutcomeTransactionTx(tx);await assertAiPrincipalTx(tx,ctx);await lockNativeOutcomeCustodyTx(tx,ctx);await tx.execute(sql`select app.native_outcome_own_erase()`);await tx.execute(sql`delete from public.ai_native_outcome_association`);return{erased:true as const};});}catch{throw new NativeOutcomeUnavailable();}
}
