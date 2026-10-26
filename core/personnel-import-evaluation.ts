/** Own source-bound evaluation custody. Canonical importer alone writes employees and completion. */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {encryptSecret,decryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {EmployeeImportEvaluationBeginSchema,EmployeeImportEvaluationBindingSchema,EmployeeImportEvaluationTelemetrySchema,EmployeeImportCanonicalCountsSchema,EmployeeImportEvaluationReceiptSchema,type EmployeeImportEvaluationBinding,type EmployeeImportEvaluationReceipt,type EmployeeImportCanonicalCounts} from '../lib/personnel-import-evaluation';
import {PERSONNEL_IMPORT_ASSISTANCE_REGISTRY_DIGEST} from '../lib/personnel-import-assistance.server';
import {assertAiPrincipalTx} from './ai-principal';
import {assertWorkforceCompanyTx} from './workforce-access';
export const EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE='This import needs a quick receipt check before we go any further.';
const fail=():never=>{throw Error(EMPLOYEE_IMPORT_EVALUATION_UNAVAILABLE);};
const context=(ctx:SessionContext)=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
export type EmployeeImportEffectInputs={companyId:string;records:Record<string,string>[];dependentRecords?:Record<string,string>[];registerRecords?:{qualification?:Record<string,string>[];emergency?:Record<string,string>[]};allocationRecords?:Record<string,string>[]};
/** Exact normalized source inputs, not a file name, uploaded bytes, preview claim or model value. */
export function employeeImportEvaluationInputDigest(p:EmployeeImportEffectInputs){
 const rows=(values:Record<string,string>[]=[])=>values.map(row=>Object.fromEntries(Object.keys(row).sort().map(key=>{if(typeof row[key]!=='string')return fail();return[key,row[key]];})));
 const text=JSON.stringify({version:1,companyId:p.companyId,records:rows(p.records),dependents:rows(p.dependentRecords),registers:{qualification:rows(p.registerRecords?.qualification),emergency:rows(p.registerRecords?.emergency)},allocations:rows(p.allocationRecords)});
 if(Buffer.byteLength(text,'utf8')>4000000)return fail();return createHash('sha256').update(text,'utf8').digest('hex');
}
const aad=(ctx:SessionContext,id:string)=>JSON.stringify(['ai-hr.employee-import-evaluation.v1',ctx.tenantId,ctx.userId,id]);
async function guard(tx:Tx,ctx:SessionContext,companyId:string){await assertAiPrincipalTx(tx,ctx);await assertWorkforceCompanyTx(tx,ctx,companyId,'view');await assertWorkforceCompanyTx(tx,ctx,companyId,'maintain');}
type Row={id:string;version:1;company_id:string;cohort_id:string;mode:'baseline'|'assisted';operation_nonce:string;binding_ciphertext:string;header_attempt_id:string|null;ai_run_id:string|null;state:'prepared'|'committed';event_id:string|null;canonical_counts:unknown;created_at:Date;committed_at:Date|null;commit_started_at:Date|null;observations:unknown[];fresh:boolean};
function sealed(row:Row,ctx:SessionContext):{sourceRevision:string;inputDigest:string}{try{const value=JSON.parse(decryptSecret(row.binding_ciphertext,aad(ctx,row.id)));if(!value||Object.keys(value).sort().join(',')!=='inputDigest,sourceRevision'||!/^[a-f0-9]{64}$/.test(value.sourceRevision)||!/^[a-f0-9]{64}$/.test(value.inputDigest))return fail();return value;}catch{return fail();}}
async function ownTx(tx:Tx,ctx:SessionContext,binding:EmployeeImportEvaluationBinding,companyId:string):Promise<Row>{
 const p=EmployeeImportEvaluationBindingSchema.parse(binding);await guard(tx,ctx,companyId);
 const [row]=await tx.execute<Row>(sql`select *,expires_at>now() as fresh from public.employee_import_evaluation_attempt where id=${p.attemptId}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid for update nowait`);
 if(!row?.fresh||row.company_id!==companyId||row.version!==p.attemptVersion)return fail();return row;
}
async function canonical(tx:Tx,ctx:SessionContext,row:Row){
 if(!row.event_id)return fail();const [event]=await tx.execute<{payload:Record<string,unknown>}>(sql`select payload from public.domain_event where id=${row.event_id}::uuid and tenant_id=${ctx.tenantId}::uuid and aggregate_type='employee-import' and aggregate_id=${row.company_id}::uuid and event_type='employee-import.completed' and actor_type='user' and actor_id=${ctx.userId}::uuid`);
 if(!event?.payload||event.payload.companyId!==row.company_id)return fail();const p=event.payload,registers=p.registers as Record<string,unknown>|undefined;
 const counts=EmployeeImportCanonicalCountsSchema.parse({imported:p.imported,failed:p.failed,skipped:p.skipped,dependents:p.dependents,qualification:registers?.qualification,emergency:registers?.emergency});
 if(JSON.stringify(counts)!==JSON.stringify(EmployeeImportCanonicalCountsSchema.parse(row.canonical_counts)))return fail();
 if(!Array.isArray(p.companyIds)||p.companyIds.length>1000||p.companyIds.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)))return fail();
 for(const companyId of [...new Set(p.companyIds)] as string[])await guard(tx,ctx,companyId);return counts;
}
async function receipt(tx:Tx,ctx:SessionContext,row:Row):Promise<EmployeeImportEvaluationReceipt>{
 const counts=row.state==='committed'?await canonical(tx,ctx,row):null;let cost:number|null=null,tokens:number|null=null,unit:'openrouter_account_credits'|null=null;
 if(row.ai_run_id){const [run]=await tx.execute<{provider:string;cost:string|null;input:number|null;output:number|null;cached:number|null;status:string|null}>(sql`select provider,openrouter_account_cost_credits as cost,reported_input_tokens::double precision as input,reported_output_tokens::double precision as output,reported_cached_input_tokens::double precision as cached,provider_observation_status as status from public.ai_model_run where id=${row.ai_run_id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and feature='personnel_import_mapping' and state='completed'`);if(!run)return fail();if(run.status==='reported'){if(run.provider==='openrouter'&&run.cost!==null){const n=Number(run.cost);if(!Number.isFinite(n)||n<0)return fail();cost=n;unit='openrouter_account_credits';}if([run.input,run.output,run.cached].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0))tokens=run.input!+run.output!+run.cached!;}}
 const observations=row.observations.map(value=>{const item=value as {recordedAt:string;reported:unknown};if(!item||Object.keys(item).sort().join(',')!=='recordedAt,reported'||!Number.isFinite(Date.parse(item.recordedAt)))return fail();return Object.freeze({recordedAt:item.recordedAt,reported:EmployeeImportEvaluationTelemetrySchema.parse(item.reported)});});
 const span=row.committed_at&&row.commit_started_at?row.committed_at.getTime()-row.commit_started_at.getTime():null;if(span!==null&&(!Number.isFinite(span)||span<0))return fail();
 return Object.freeze(EmployeeImportEvaluationReceiptSchema.parse({attemptId:row.id,attemptVersion:1,companyId:row.company_id,cohortId:row.cohort_id,mode:row.mode,state:row.state,createdAt:row.created_at.toISOString(),committedAt:row.committed_at?.toISOString()??null,serverCommitMilliseconds:span,canonicalCounts:counts,association:row.ai_run_id?'human_confirmed':'none',accounting:Object.freeze({associatedRuns:row.ai_run_id?1:0,accountCostCredits:cost,unit,attribution:row.ai_run_id?'associated_run_unallocated':'none',providerReportedTokens:tokens}),observations:Object.freeze(observations)}));
}
export async function beginEmployeeImportEvaluation(ctx:SessionContext,inputs:EmployeeImportEffectInputs,value:unknown):Promise<EmployeeImportEvaluationReceipt>{
 ctx=context(ctx);inputs=structuredClone(inputs);const p=EmployeeImportEvaluationBeginSchema.parse(value),inputDigest=employeeImportEvaluationInputDigest(inputs);if(p.companyId!==inputs.companyId||!isSecretStorable())return fail();
 return withTenant(ctx,async tx=>{await guard(tx,ctx,p.companyId);
  const [prior]=await tx.execute<{id:string}>(sql`select id from public.employee_import_evaluation_attempt where tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and operation_nonce=${p.operationNonce}::uuid`);
  if(prior){const row=await ownTx(tx,ctx,{attemptId:prior.id,attemptVersion:1},p.companyId),bound=sealed(row,ctx);if(row.mode!==p.mode||row.cohort_id!==p.cohortId||row.header_attempt_id!==p.adoptedHeaderAttemptId||bound.inputDigest!==inputDigest||bound.sourceRevision!==p.sourceRevision)return fail();return receipt(tx,ctx,row);}
  let runId:string|null=null;
  if(p.mode==='assisted'){const [header]=await tx.execute<{ai_run_id:string}>(sql`select a.ai_run_id from public.personnel_import_assistance_attempt a join public.ai_model_run r on r.id=a.ai_run_id where a.id=${p.adoptedHeaderAttemptId}::uuid and a.tenant_id=${ctx.tenantId}::uuid and a.user_id=${ctx.userId}::uuid and a.company_id=${p.companyId}::uuid and a.registry_digest=${PERSONNEL_IMPORT_ASSISTANCE_REGISTRY_DIGEST} and a.mode='ai' and a.state='completed' and a.expires_at>now() and r.user_id=a.user_id and r.tenant_id=a.tenant_id and r.feature='personnel_import_mapping' and r.state='completed' for share of a`);if(!header)return fail();runId=header.ai_run_id;}
  const id=randomUUID();await tx.execute(sql`insert into public.employee_import_evaluation_attempt(id,tenant_id,user_id,company_id,cohort_id,operation_nonce,mode,binding_ciphertext,header_attempt_id,ai_run_id) values(${id}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,${p.companyId}::uuid,${p.cohortId}::uuid,${p.operationNonce}::uuid,${p.mode},${encryptSecret(JSON.stringify({sourceRevision:p.sourceRevision,inputDigest}),aad(ctx,id))},${p.adoptedHeaderAttemptId}::uuid,${runId}::uuid) on conflict(tenant_id,user_id,operation_nonce) do nothing`);
  const [existing]=await tx.execute<{id:string}>(sql`select id from public.employee_import_evaluation_attempt where tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and operation_nonce=${p.operationNonce}::uuid`);if(!existing)return fail();const row=await ownTx(tx,ctx,{attemptId:existing.id,attemptVersion:1},p.companyId),bound=sealed(row,ctx);
  if(row.mode!==p.mode||row.cohort_id!==p.cohortId||row.header_attempt_id!==p.adoptedHeaderAttemptId||row.ai_run_id!==runId||bound.inputDigest!==inputDigest||bound.sourceRevision!==p.sourceRevision)return fail();return receipt(tx,ctx,row);
 });
}
/** Metadata preflight only; catches completed retries BEFORE a changed post-import preview. */
export async function readEmployeeImportEvaluationTx(tx:Tx,ctx:SessionContext,input:EmployeeImportEvaluationBinding,inputs:EmployeeImportEffectInputs){
 ctx=context(ctx);const p=EmployeeImportEvaluationBindingSchema.parse(input),captured=structuredClone(inputs),digest=employeeImportEvaluationInputDigest(captured),row=await ownTx(tx,ctx,p,captured.companyId);if(sealed(row,ctx).inputDigest!==digest)return fail();return row.state==='committed'?receipt(tx,ctx,row):null;
}
/** Enclosing importer owns Access/config first. Held row persists through ALL canonical writes. */
export async function claimEmployeeImportEvaluationTx(tx:Tx,ctx:SessionContext,input:EmployeeImportEvaluationBinding,inputs:EmployeeImportEffectInputs){
 ctx=context(ctx);const p=EmployeeImportEvaluationBindingSchema.parse(input),captured=structuredClone(inputs),digest=employeeImportEvaluationInputDigest(captured),row=await ownTx(tx,ctx,p,captured.companyId);if(sealed(row,ctx).inputDigest!==digest)return fail();
 if(row.state==='committed')return{replayed:await receipt(tx,ctx,row)};
 await tx.execute(sql`update public.employee_import_evaluation_attempt set commit_started_at=clock_timestamp() where id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);return{replayed:null};
}
export async function completeEmployeeImportEvaluationTx(tx:Tx,ctx:SessionContext,input:EmployeeImportEvaluationBinding,companyId:string,eventId:string,counts:EmployeeImportCanonicalCounts){
 ctx=context(ctx);const p=EmployeeImportEvaluationBindingSchema.parse(input),checked=EmployeeImportCanonicalCountsSchema.parse(counts),row=await ownTx(tx,ctx,p,companyId);if(row.state==='committed'){if(row.event_id!==eventId||JSON.stringify(checked)!==JSON.stringify(EmployeeImportCanonicalCountsSchema.parse(row.canonical_counts)))return fail();return receipt(tx,ctx,row);}if(!row.commit_started_at)return fail();
 const [current]=await tx.execute<{same:boolean}>(sql`select xmin=pg_current_xact_id()::xid as same from public.domain_event where id=${eventId}::uuid and tenant_id=${ctx.tenantId}::uuid`);if(current?.same!==true)return fail();
 await tx.execute(sql`update public.employee_import_evaluation_attempt set state='committed',event_id=${eventId}::uuid,canonical_counts=${JSON.stringify(checked)}::jsonb,committed_at=clock_timestamp() where id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);
 return receipt(tx,ctx,await ownTx(tx,ctx,p,companyId));
}
/** Explicit own receipt lookup only. Never analyzes or imports source rows. */
export async function reopenEmployeeImportEvaluation(ctx:SessionContext,input:EmployeeImportEvaluationBinding,companyId:string){ctx=context(ctx);const p=EmployeeImportEvaluationBindingSchema.parse(input);return withTenant(ctx,async tx=>receipt(tx,ctx,await ownTx(tx,ctx,p,companyId)));}
export async function recordEmployeeImportEvaluationTelemetry(ctx:SessionContext,input:EmployeeImportEvaluationBinding,companyId:string,value:unknown){ctx=context(ctx);const p=EmployeeImportEvaluationBindingSchema.parse(input),event=EmployeeImportEvaluationTelemetrySchema.parse(value);return withTenant(ctx,async tx=>{const row=await ownTx(tx,ctx,p,companyId);if(event.stage.kind==='outcome'&&event.stage.origin==='human_attested'){if(row.state!=='committed')return fail();const counts=await canonical(tx,ctx,row),verified=event.stage.verifiedCommittedRows;if(verified===null||verified>counts.imported||[event.stage.errorRows,event.stage.duplicateRows,event.stage.reworkRows].some(n=>n!==null&&n>verified))return fail();}const found=row.observations.find(v=>(v as {reported:{nonce:string}}).reported.nonce===event.nonce);if(found){if(JSON.stringify((found as {reported:unknown}).reported)!==JSON.stringify(event))return fail();return receipt(tx,ctx,row);}if(row.observations.length>=32)return fail();await tx.execute(sql`update public.employee_import_evaluation_attempt set observations=observations||jsonb_build_array(jsonb_build_object('recordedAt',clock_timestamp(),'reported',${JSON.stringify(event)}::jsonb)) where id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);const next=await ownTx(tx,ctx,p,companyId);return receipt(tx,ctx,next);});}
