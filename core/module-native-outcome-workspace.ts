import {finishNativeOutcomeJobRecheckTx} from './module-native-outcome-references';
/** Metadata discovery is NOT native completion proof. No pending body, event or HR value is read. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../db/client';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';
import {beginOwnNativeOutcomeJobProvenanceTx} from './module-agent-releases';
import {NATIVE_OUTCOME_ACTIONS,NATIVE_REVIEW_ACTIONS,NativeOutcomeReference,type NativeOutcomeAction} from '../lib/ai/module-native-outcomes';
const Id=z.uuid().transform(v=>v.toLowerCase());
const capture=(ctx:SessionContext)=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const date=(value:Date|string)=>new Date(value).toISOString();
export type NativeOutcomeChoice=Readonly<{reference:NativeOutcomeReference;createdAt:string}>;
export type NativeOutcomeLink=Readonly<{associationId:string;action:NativeOutcomeAction;createdAt:string}>;
export type NativeOutcomeWorkspace=Readonly<{jobId:string;choices:readonly NativeOutcomeChoice[];links:readonly NativeOutcomeLink[];truncated:boolean}>;
/** Ordinary READ COMMITTED is required by the actual current-principal/native owners. Queries only;
 * no nested public reopen or pending-content decryption occurs within this owned interval. */
export async function loadOwnNativeOutcomeWorkspace(supplied:SessionContext,value:unknown):Promise<NativeOutcomeWorkspace>{
 const ctx=capture(supplied),jobId=Id.parse(value);
 return withTenant(ctx,async tx=>{
  await boundNativeOutcomeTransactionTx(tx);
  const provenance=await beginOwnNativeOutcomeJobProvenanceTx(tx,ctx,jobId);
  await finishNativeOutcomeJobRecheckTx(tx,ctx,provenance);
  const kinds=NATIVE_REVIEW_ACTIONS.filter(action=>provenance.modules.includes(NATIVE_OUTCOME_ACTIONS[action].module));
  const reviews=kinds.length?await tx.execute<{action:NativeOutcomeAction;action_id:string;created_at:Date|string}>(sql`select action,action_id,created_at from app.native_outcome_completed_review_choices(${JSON.stringify(kinds)}::jsonb)`):[];
  const choices:NativeOutcomeChoice[]=reviews.map(row=>({reference:NativeOutcomeReference.parse({source:'review',action:row.action,actionId:row.action_id}),createdAt:date(row.created_at)}));
  if(provenance.modules.includes('employees')){
   const imports=await tx.execute<{id:string;version:number;company_id:string;created_at:Date|string}>(sql`select id,version,company_id,created_at from public.employee_import_evaluation_attempt where tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and state='committed' and app.native_outcome_capture_available('employees.import',id) and expires_at>now() and created_at<=now() and created_at>now()-interval '30 days' order by created_at desc,id desc limit 26`);
   choices.push(...imports.map(row=>({reference:NativeOutcomeReference.parse({source:'employee_import',action:'employees.import',attemptId:row.id,attemptVersion:row.version,companyId:row.company_id}),createdAt:date(row.created_at)})));
  }
  choices.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||JSON.stringify(b.reference).localeCompare(JSON.stringify(a.reference)));
  const links=await tx.execute<{id:string;action:string;created_at:Date|string}>(sql`select id,action,created_at from public.ai_native_outcome_association where job_id=${jobId}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and expires_at>now() order by created_at desc,id desc limit 26`);
  const parsed=links.map(row=>{if(!Object.hasOwn(NATIVE_OUTCOME_ACTIONS,row.action))throw Error('Outcome unavailable');return{associationId:Id.parse(row.id),action:row.action as NativeOutcomeAction,createdAt:date(row.created_at)};});
  return{jobId,choices:choices.slice(0,25),links:parsed.slice(0,25),truncated:choices.length>25||parsed.length>25};
 });
}
