/** Header-only assistance custody. No employee rows, file names or prompt bodies are stored.
 * A dispatched attempt never automatically resends, including after an uncertain response.
 */
import {randomUUID,createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {AiGatewayError} from '../lib/ai/types';
import {encryptSecret,decryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {assertAiPrincipalTx} from './ai-principal';
import {assertWorkforceCompanyTx} from './workforce-access';
import {capturePersonnelImportHeaderProposal,type PersonnelImportHeaderProposal} from '../lib/personnel-import-assistance';
import {PERSONNEL_IMPORT_ASSISTANCE_REGISTRY_DIGEST} from '../lib/personnel-import-assistance.server';

export type PersonnelImportAssistanceBinding=Readonly<{attemptId:string;attemptVersion:number;companyId:string;sourceRevision:string;registryDigest:string;inputDigest:string}>;
type Prepare=Readonly<{companyId:string;operationNonce:string;sourceRevision:string;registryDigest:string;headersDigest:string;inputDigest:string;headerIndexes:readonly number[];mode:'deterministic'|'ai';consent:Readonly<{headersReviewed:true;sendHeadingsOnly:boolean}>}>;
type Row={operation_nonce:string;id:string;company_id:string;version:number;source_revision:string;registry_digest:string;headers_digest:string;input_digest:string;header_indexes:number[];mode:'deterministic'|'ai';state:'ready'|'dispatched'|'completed'|'failed';ai_run_id:string|null;receipt:string|null;fresh:boolean};
const capture=(ctx:SessionContext)=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const fail=():never=>{throw new AiGatewayError('Let’s review those headings again before trying this import.');};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const aad=(ctx:SessionContext,id:string)=>JSON.stringify(['ai-hr.personnel-import-header.v1',ctx.tenantId,ctx.userId,id]);
async function guard(tx:Tx,ctx:SessionContext,companyId:string){
 if(!uuid(companyId))return fail();await assertAiPrincipalTx(tx,ctx);
 await assertWorkforceCompanyTx(tx,ctx,companyId,'view');await assertWorkforceCompanyTx(tx,ctx,companyId,'maintain');
}
function binding(value:PersonnelImportAssistanceBinding){
 const p={...value};if(!uuid(p.attemptId)||!uuid(p.companyId)||p.attemptVersion!==1||!digest(p.sourceRevision)||!digest(p.registryDigest)||!digest(p.inputDigest)||p.registryDigest!==PERSONNEL_IMPORT_ASSISTANCE_REGISTRY_DIGEST)return fail();return Object.freeze(p);
}
async function rowTx(tx:Tx,ctx:SessionContext,p:PersonnelImportAssistanceBinding):Promise<Row>{
 await guard(tx,ctx,p.companyId);
 const [row]=await tx.execute<Row>(sql`select id,operation_nonce,company_id,version,source_revision,registry_digest,headers_digest,input_digest,header_indexes,mode,state,ai_run_id,receipt,(expires_at>now()) as fresh
  from public.personnel_import_assistance_attempt where id=${p.attemptId}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid for update nowait`);
 if(!row?.fresh||row.company_id!==p.companyId||row.version!==p.attemptVersion||row.source_revision!==p.sourceRevision||row.registry_digest!==p.registryDigest||row.input_digest!==p.inputDigest)return fail();return row;
}
function proposal(row:Row,ctx:SessionContext):PersonnelImportHeaderProposal{
 if(!row.receipt||!isSecretStorable())return fail();try{
  const value=capturePersonnelImportHeaderProposal(JSON.parse(decryptSecret(row.receipt,aad(ctx,row.id))),row.header_indexes.map(columnIndex=>({columnIndex})));
  if(value.sourceRevision!==row.source_revision||value.registryDigest!==row.registry_digest)return fail();return value;
 }catch{return fail();}
}
export async function preparePersonnelImportAssistanceTx(tx:Tx,ctx:SessionContext,input:Prepare){
 ctx=capture(ctx);const p=structuredClone(input);if(!uuid(p.operationNonce)||!digest(p.sourceRevision)||!digest(p.registryDigest)||!digest(p.headersDigest)||!digest(p.inputDigest)||p.registryDigest!==PERSONNEL_IMPORT_ASSISTANCE_REGISTRY_DIGEST||p.sourceRevision!==createHash('sha256').update(JSON.stringify([p.headersDigest,p.registryDigest])).digest('hex')||!['deterministic','ai'].includes(p.mode)||
  p.consent?.headersReviewed!==true||(p.mode==='ai'&&p.consent?.sendHeadingsOnly!==true)||!Array.isArray(p.headerIndexes)||p.headerIndexes.length<1||p.headerIndexes.length>128||(p.mode==='ai'&&p.headerIndexes.length>32)||
  p.headerIndexes.some(n=>!Number.isSafeInteger(n)||n<0||n>16383)||new Set(p.headerIndexes).size!==p.headerIndexes.length||!isSecretStorable())return fail();
 await guard(tx,ctx,p.companyId);
 await tx.execute(sql`insert into public.personnel_import_assistance_attempt(id,tenant_id,user_id,company_id,operation_nonce,source_revision,registry_digest,headers_digest,input_digest,header_indexes,mode)
  values(${randomUUID()}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,${p.companyId}::uuid,${p.operationNonce}::uuid,${p.sourceRevision},${p.registryDigest},${p.headersDigest},${p.inputDigest},${JSON.stringify(p.headerIndexes)}::jsonb,${p.mode})
  on conflict(tenant_id,user_id,operation_nonce) do nothing`);
 const [found]=await tx.execute<{id:string}>(sql`select id from public.personnel_import_assistance_attempt where tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and operation_nonce=${p.operationNonce}::uuid`);
 if(!found)return fail();const b={attemptId:found.id,attemptVersion:1,companyId:p.companyId,sourceRevision:p.sourceRevision,registryDigest:p.registryDigest,inputDigest:p.inputDigest};
 const row=await rowTx(tx,ctx,b);if(row.mode!==p.mode||row.headers_digest!==p.headersDigest||JSON.stringify(row.header_indexes)!==JSON.stringify(p.headerIndexes)||!['ready','completed'].includes(row.state))return fail();
 return Object.freeze({attemptId:row.id,attemptVersion:row.version,sourceRevision:row.source_revision,state:row.state as 'ready'|'completed',...(row.state==='completed'?{proposal:proposal(row,ctx)}:{})});
}
/** Called only by the opaque trusted gateway hook, inside the actual successful admission Tx. */
export async function claimPersonnelImportAssistanceTx(tx:Tx,ctx:SessionContext,input:PersonnelImportAssistanceBinding,runId:string){
 ctx=capture(ctx);const p=binding(input);if(!uuid(runId))return fail();const row=await rowTx(tx,ctx,p);if(row.state!=='ready'||row.mode!=='ai')return fail();
 const changed=await tx.execute<{id:string}>(sql`update public.personnel_import_assistance_attempt a set state='dispatched',ai_run_id=${runId}::uuid,dispatched_at=now()
  where a.id=${row.id}::uuid and a.tenant_id=${ctx.tenantId}::uuid and a.user_id=${ctx.userId}::uuid and a.state='ready'
   and exists(select 1 from public.ai_model_run r where r.id=${runId}::uuid and r.tenant_id=a.tenant_id and r.user_id=a.user_id and r.feature='personnel_import_mapping' and r.state='pending') returning a.id`);
 if(changed.length!==1)return fail();
}
export async function completePersonnelImportAssistanceTx(tx:Tx,ctx:SessionContext,input:PersonnelImportAssistanceBinding,value:PersonnelImportHeaderProposal){
 ctx=capture(ctx);const p=binding(input),captured=structuredClone(value),row=await rowTx(tx,ctx,p);
 const checked=capturePersonnelImportHeaderProposal(captured,row.header_indexes.map(columnIndex=>({columnIndex})));
 if(checked.sourceRevision!==p.sourceRevision||checked.registryDigest!==p.registryDigest)return fail();
 if(row.state==='completed'){if(JSON.stringify(proposal(row,ctx))!==JSON.stringify(checked))return fail();return;}
 if(row.state!=='dispatched'&&!(row.state==='ready'&&row.mode==='deterministic'))return fail();
 if(row.mode==='ai'){const [settled]=await tx.execute<{confirmed:boolean}>(sql`select exists(select 1 from public.ai_model_run where id=${row.ai_run_id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and feature='personnel_import_mapping' and state='completed') as confirmed`);if(settled?.confirmed!==true)return fail();}
 await tx.execute(sql`update public.personnel_import_assistance_attempt set state='completed',receipt=${encryptSecret(JSON.stringify(checked),aad(ctx,row.id))},completed_at=now()
  where id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);
}
export async function failPersonnelImportAssistanceTx(tx:Tx,ctx:SessionContext,input:PersonnelImportAssistanceBinding){
 ctx=capture(ctx);const p=binding(input),row=await rowTx(tx,ctx,p);if(row.state==='failed')return;if(row.state!=='dispatched')return fail();
 await tx.execute(sql`update public.personnel_import_assistance_attempt set state='failed',receipt=null,completed_at=now() where id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);
}

/** Existing identity only: execute/reopen can NEVER recreate an erased or expired attempt. */
export async function readPersonnelImportAssistanceTx(tx:Tx,ctx:SessionContext,input:PersonnelImportAssistanceBinding,expected:Prepare){
 ctx=capture(ctx);const p=binding(input),e=structuredClone(expected),row=await rowTx(tx,ctx,p);
 if(row.operation_nonce!==e.operationNonce||row.mode!==e.mode||row.headers_digest!==e.headersDigest||
  JSON.stringify(row.header_indexes)!==JSON.stringify(e.headerIndexes)||e.companyId!==p.companyId||e.sourceRevision!==p.sourceRevision||
  e.registryDigest!==p.registryDigest||e.inputDigest!==p.inputDigest||e.consent?.headersReviewed!==true||
  (row.mode==='ai'&&e.consent.sendHeadingsOnly!==true))return fail();
 return Object.freeze({attemptId:row.id,attemptVersion:row.version,sourceRevision:row.source_revision,state:row.state,...(row.state==='completed'?{proposal:proposal(row,ctx)}:{})});
}
