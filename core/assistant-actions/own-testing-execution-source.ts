/** UNMOUNTED human-observation adapter. Requires unallocated testing-execution-source.sql and shared
 * USER-scoped custody; a tester need not have a person/employment. No model verdict or harness truth. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {pgSqlState} from '../../lib/db-error';
import {TestingRefusal,testingUuid,testingHash,EXECUTION_STATUSES} from '../../lib/system-testing/model';
import {OwnTestingExecutionIntent,OwnTestingExecutionReview,OwnTestingExecutionReceipt} from '../../lib/assistant-actions/own-testing-execution-contract';
import {prepareTestingExecutionSaveTx,saveTestingExecutionTx,readOwnTestingExecutionSourceTx,testingExecutionPreparedDigest} from '../system-testing-workspace';
import {isAiPrincipalCurrentTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {assertModuleEnabled,resolveEntitlementsTx} from '../entitlements';
const fail=():never=>{throw new TestingRefusal('not_assigned');};
/** Existing helper remains blocking. This adapter permits at most 1000ms PER lock wait, never raises
 * an existing nonzero bound, and restores exact caller text on success or valid business refusal.
 * A PostgreSQL statement error leaves this Tx unusable: no reset/continued work, whole outer rollback. */
async function bounded<T>(tx:Tx,work:()=>Promise<T>):Promise<T>{
 const [prior]=await tx.execute<{saved:string;milliseconds:number;unit:string}>(sql`select current_setting('lock_timeout') as saved,setting::integer as milliseconds,unit from pg_settings where name='lock_timeout'`);
 if(!prior||prior.unit!=='ms'||!Number.isSafeInteger(prior.milliseconds)||prior.milliseconds<0)return fail();
 const limit=prior.milliseconds===0?1000:Math.min(prior.milliseconds,1000);await tx.execute(sql`select set_config('lock_timeout',${String(limit)+'ms'},true)`);
 let result:T;
 try{result=await work();}catch(error){
  if(!pgSqlState(error)){try{await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);}catch{/* Original error still requires whole-transaction rollback. */}}
  throw error;
 }
 await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);return result;
}
async function guard(tx:Tx,supplied:SessionContext){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 // The canonical non-wrapping reader retains SQLSTATE for bounded aborted-Tx handling above.
 if(!await isAiPrincipalCurrentTx(tx,ctx))return fail();
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'system_testing');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;
}
const NativeReference=OwnTestingExecutionReceipt.pick({runId:true,eventId:true}).strict();
const NativeSource=z.object({case_id:testingUuid,assignment_id:testingUuid,execution_id:testingUuid,version_id:testingUuid,run_id:testingUuid,event_id:testingUuid,
 execution_revision:z.number().int().positive(),execution_status:z.enum(EXECUTION_STATUSES),content_hash:testingHash,source_content_hash:testingHash.nullable()}).strict();
async function native(tx:Tx,runId:string,eventId:string){const rows=await tx.execute(sql`select * from app.testing_own_execution_event_source(${runId}::uuid,${eventId}::uuid)`);if(rows.length!==1)return fail();return NativeSource.parse(rows[0]);}
async function reopen(tx:Tx,ctx:SessionContext,reference:z.infer<typeof NativeReference>){
 const first=await native(tx,reference.runId,reference.eventId);
 const current=await readOwnTestingExecutionSourceTx(tx,ctx,{assignmentId:first.assignment_id,executionId:first.execution_id,versionId:first.version_id,expectedRevision:first.execution_revision});
 const checked=await native(tx,reference.runId,reference.eventId);
 if(checked.run_id!==first.run_id||checked.execution_revision!==current.executionRevision||checked.case_id!==current.caseId||checked.content_hash!==current.published.contentHash||checked.source_content_hash!==current.published.sourceContentHash)return fail();
 return OwnTestingExecutionReceipt.parse({version:1,action:'system_testing.execution.save',proof:'recorded_human_observation_current_own_run',caseId:checked.case_id,assignmentId:checked.assignment_id,executionId:checked.execution_id,
  versionId:checked.version_id,runId:checked.run_id,eventId:checked.event_id,revision:checked.execution_revision,status:checked.execution_status,meaning:'human_observation_recorded_not_independently_verified'});
}
/** The full ExecutionInput is explicitly entered/confirmed by the human, never filled by a model.
 * Published metadata only; draftDefinition and instruction narrative never enter the card/digest. */
export async function prepareOwnTestingExecutionTx(tx:Tx,ctx:SessionContext,input:unknown){
 const intent=OwnTestingExecutionIntent.parse(input);return bounded(tx,async()=>{const fresh=await guard(tx,ctx),prepared=await prepareTestingExecutionSaveTx(tx,fresh,intent.observation),s=prepared.source;
  return OwnTestingExecutionReview.parse({version:1,action:'system_testing.execution.save',humanObservation:prepared.input,caseId:s.caseId,caseNo:s.caseNo,assignmentId:s.assignmentId,executionId:s.executionId,
   versionId:s.published.id,instructionOrdinal:s.published.ordinal,meaning:'human_observation_not_independently_verified',reviewDigest:testingExecutionPreparedDigest(fresh,prepared)});
 });
}
/** Shared custody must own the exact confirmed input and commit completion in this top-level Tx.
 * Human 'passed' is a recorded claim, not independent evaluation evidence or a permission to promote. */
export async function confirmOwnTestingExecutionTx(tx:Tx,ctx:SessionContext,input:unknown,expectedDigest:string){
 const intent=OwnTestingExecutionIntent.parse(input);return bounded(tx,async()=>{const fresh=await guard(tx,ctx),effect=await saveTestingExecutionTx(tx,fresh,intent.observation,{expectedDigest});return reopen(tx,fresh,{runId:effect.runId,eventId:effect.eventId});});
}
export async function reopenOwnTestingExecutionEventTx(tx:Tx,ctx:SessionContext,input:unknown){
 const reference=NativeReference.parse(input);return bounded(tx,async()=>{const fresh=await guard(tx,ctx);return reopen(tx,fresh,reference);});
}
