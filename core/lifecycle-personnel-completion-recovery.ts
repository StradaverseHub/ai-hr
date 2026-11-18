/** Two explicit background jobs: a no-business-write review, then HR-selected adoption.
 * The request only pages metadata or admits a sealed manifest. Current Personnel values are
 * resolved one target per worker checkpoint, never through a per-person request loop. */
import {sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {withLifecycleTenant} from './module-gate';
import {withAccessDisplayRead,lockAccessConfigurationReadTx} from './access-configuration-lock';
import {enqueueBulkJobTx,bulkJobTx} from './bulk-job';
import type {BulkJobHandler} from './bulk-job-worker';
import {recoverPersonnelCompletionRunsTx} from '../packs/lifecycle/service';
const previewKind='lifecycle_personnel_completion_preview',applyKind='lifecycle_personnel_completion_recovery';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const personnelCompletionRecoveryCandidate=z.object({tenantId:z.uuid(),caseId:z.uuid(),companyId:z.uuid(),revision:z.number().int().positive(),documentId:z.string().min(1).max(200),documentHash:digest,contextHash:digest}).strict();
const run=z.object({id:z.string().min(1).max(1000),stepId:z.string().min(1).max(120),dueOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict();
export const personnelCompletionRecoveryReview=z.object({candidate:personnelCompletionRecoveryCandidate,outcome:z.enum(['eligible','future','late','manualReview','changed','alreadyAdopted']),reviewHash:digest.optional(),sourceFingerprint:digest.optional(),runs:z.array(run).max(1000).optional(),reason:z.string().max(2000).optional()}).passthrough();
export type PersonnelCompletionRecoveryCandidate=z.infer<typeof personnelCompletionRecoveryCandidate>;
export type PersonnelCompletionRecoveryReview=z.infer<typeof personnelCompletionRecoveryReview>;
function human(ctx:SessionContext){if(!ctx.userId||ctx.agent)throw new Error('Sign in as authorised HR to review Personnel completion recovery.');}
const valid=(r:PersonnelCompletionRecoveryReview)=>['eligible','future','late'].includes(r.outcome)&&!!r.reviewHash&&!!r.sourceFingerprint&&!!r.runs?.length;
const candidates=z.array(personnelCompletionRecoveryCandidate).min(1).max(1000);
const reviews=z.array(personnelCompletionRecoveryReview).min(1).max(1000);
function unique(targets:PersonnelCompletionRecoveryCandidate[]){return new Set(targets.map(t=>t.caseId+'\0'+t.documentId)).size===targets.length;}
export async function personnelCompletionRecoveryPage(ctx:SessionContext,after:{caseId:string;documentId:string}|null=null,limit=50){
 human(ctx);const cursor=after?z.object({caseId:z.uuid(),documentId:z.string().max(200)}).strict().parse(after):null;
 return withAccessDisplayRead(()=>withLifecycleTenant(ctx,async tx=>{const [r]=await tx.execute<{result:unknown}>(sql`select app.personnel_completion_recovery_candidates(${cursor?.caseId??null}::uuid,${cursor?.documentId??null}::text,${Math.min(100,Math.max(1,Math.trunc(limit)||50))}) as result`);return r.result;},{readOnlySnapshot:true}));
}
/** No source lookup per employee here: only current full-case authority, as one statement. */
async function admissionTx(tx:Tx,ctx:SessionContext,targets:PersonnelCompletionRecoveryCandidate[]){
 const [r]=await tx.execute<{count:number}>(sql`with requested as(select * from jsonb_to_recordset(${JSON.stringify(targets)}::jsonb) t("caseId" uuid,"companyId" uuid,revision integer)), visible as(
 select r."caseId" from requested r join lc_v9_case c on c.id=r."caseId" and c.company_id=r."companyId" and c.revision=r.revision where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.company_id) and app.lc_v9_off_access(c.company_id)
 union all select r."caseId" from requested r join lc_onboarding_case c on c.id=r."caseId" and c.company_id=r."companyId" and c.revision=r.revision where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.company_id) and (app.onboarding_page_access() or app.onboarding_v9_case_actor() or app.is_group_admin())) select count(*)::integer as count from visible where app.v9_signing_current_actor()`);
 if(r.count!==targets.length)throw new Error('Current full case access and the reviewed revisions are required for every target.');
}
async function enqueueTx(tx:Tx,ctx:SessionContext,kind:string,targets:PersonnelCompletionRecoveryCandidate[],manifest:unknown){
 const content=Buffer.from(JSON.stringify(manifest));if(content.length>2_000_000)throw new Error('Keep each reviewed recovery manifest within 2 MB.');
 return enqueueBulkJobTx(tx,ctx,{kind,companyIds:[...new Set(targets.map(t=>t.companyId))],source:{name:'personnel-completion-recovery.json',content},input:{token:createHash('sha256').update(content).digest('hex')}});
}
export async function requestPersonnelCompletionRecoveryPreview(ctx:SessionContext,input:unknown){
 human(ctx);const targets=candidates.parse(input);if(!unique(targets)||targets.some(t=>t.tenantId!==ctx.tenantId))throw new Error('Use unique same-tenant document targets.');
 return withLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);await admissionTx(tx,ctx,targets);return enqueueTx(tx,ctx,previewKind,targets,targets);});
}
export async function readPersonnelCompletionRecoveryPreview(ctx:SessionContext,jobId:string,after=0,limit=100){
 human(ctx);return withAccessDisplayRead(()=>withLifecycleTenant(ctx,async tx=>{const job=await bulkJobTx(tx,jobId,{kind:previewKind});const rows=await tx.execute<{seq:number;state:string;result:unknown;error:string|null;total:number}>(sql`select seq,state,result,error,count(*) over()::integer as total from bulk_job_step where job_id=${job.id}::uuid and tenant_id=${ctx.tenantId}::uuid and seq>${Math.max(0,Math.trunc(after)||0)} order by seq limit ${Math.min(100,Math.max(1,Math.trunc(limit)||100))}`);return{jobId:job.id,state:job.state,items:rows.map(({total:_,...row})=>row),remainingCount:Number(rows[0]?.total??0),after:rows.at(-1)?.seq??null};},{readOnlySnapshot:true}));
}
/** Accept only exact results from the creator's completed, kernel-sealed preview. */
export async function requestPersonnelCompletionRecovery(ctx:SessionContext,input:{previewJobId:string;reviewHashes:string[];confirmed:true}){
 human(ctx);const request=z.object({previewJobId:z.uuid(),reviewHashes:z.array(digest).min(1).max(1000),confirmed:z.literal(true)}).strict().parse(input);
 if(new Set(request.reviewHashes).size!==request.reviewHashes.length)throw new Error('Choose each reviewed result once.');
 return withLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const job=await bulkJobTx(tx,request.previewJobId,{kind:previewKind});if(job.state!=='completed')throw new Error('Wait for the preview to finish before selecting recovery.');
  const hashes=sql`ARRAY[${sql.join(request.reviewHashes.map(h=>sql`${h}::text`),sql`, `)}]::text[]`;
  const rows=await tx.execute<{result:unknown}>(sql`select result from bulk_job_step where tenant_id=${ctx.tenantId}::uuid and job_id=${job.id}::uuid and state='applied' and result->>'reviewHash'=any(${hashes}) order by seq`);
  const selected=reviews.parse(rows.map(row=>row.result));if(selected.length!==request.reviewHashes.length||selected.some(r=>!valid(r)))throw new Error('Choose only eligible, unchanged preview results.');
  const targets=selected.map(r=>r.candidate);if(new Set(targets.map(t=>t.caseId)).size!==targets.length)throw new Error('Choose one saved document per case in each recovery batch; preview the remaining documents again afterward.');if(!unique(targets)||targets.some(t=>t.tenantId!==ctx.tenantId))throw new Error('The reviewed recovery scope changed.');await admissionTx(tx,ctx,targets);return enqueueTx(tx,ctx,applyKind,targets,selected);
 });
}
function handler(preview:boolean):BulkJobHandler<unknown>{return{
 kind:preview?previewKind:applyKind,mode:'per-step',maxStepsPerChunk:1,chunkBudgetMs:100,phaseOf:()=>preview?'reviewing':'rechecking',
 async prepare(ctx,job){const bytes=Buffer.from(job.source_content??Buffer.alloc(0)),input=z.object({token:digest}).strict().parse(job.input);if(createHash('sha256').update(bytes).digest('hex')!==input.token)return{refused:'The recovery manifest identity changed.'};
  const manifest=preview?candidates.parse(JSON.parse(bytes.toString('utf8'))):reviews.parse(JSON.parse(bytes.toString('utf8')));const targets=preview?manifest as PersonnelCompletionRecoveryCandidate[]:(manifest as PersonnelCompletionRecoveryReview[]).map(r=>r.candidate);if(!unique(targets)||targets.some(t=>t.tenantId!==ctx.tenantId))return{refused:'The recovery tenant or document scope changed.'};return{steps:manifest.map(target=>({kind:preview?'review':'adopt',payload:target})),counters:{total:targets.length}};
 },
 async beginChunkTx(tx,ctx){await lockAccessConfigurationReadTx(tx,ctx.tenantId);},
 async applyStepTx(tx,ctx,_job,step){
  if(preview){const target=personnelCompletionRecoveryCandidate.parse(step.payload);const [r]=await tx.execute<{result:unknown}>(sql`select app.personnel_completion_recovery_review(${JSON.stringify(target)}::jsonb) as result`);const result=personnelCompletionRecoveryReview.parse(r.result);return{result,counters:{[result.outcome]:1}};}
  const reviewed=personnelCompletionRecoveryReview.parse(step.payload);if(!valid(reviewed))throw new Error('The selected preview is not eligible for recovery.');const [r]=await tx.execute<{revision:number}>(sql`select app.personnel_completion_recovery_adopt(${JSON.stringify(reviewed)}::jsonb) as revision`);if(!Number.isInteger(r.revision)||r.revision<1)throw new Error('The recovery target changed. Review a fresh preview.');
  const result=await recoverPersonnelCompletionRunsTx(tx,ctx,{caseId:reviewed.candidate.caseId,revision:r.revision,documentId:reviewed.candidate.documentId,runs:reviewed.runs!});return{result,counters:{adopted:1,[result.outcome]:1}};
 },
 async finalize(_ctx,job){return{result:{...job.counters,failed:job.errors.length}};},
};}
export const lifecyclePersonnelCompletionPreviewHandler=handler(true);
export const lifecyclePersonnelCompletionRecoveryHandler=handler(false);
